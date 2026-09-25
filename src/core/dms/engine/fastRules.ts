// The fast drowsiness rules (plan §M6; spec "Fast rules"). Closure itself (openness by the max usable
// eye, the near eye past 25°, 0.30/0.45 hysteresis, TRACKING only) is the conditioner's; this file turns
// closure episodes into F1–F4 and blinks. Pure.
//
// - The looking-down gate (Task C2: latched per episode, rev4 §2.3.6, S1): at the ONSET of a closure episode
//   it is set when any open-eye frame of the 500 ms before onset was looking down (rel pitch below −15°);
//   during the episode a looking-down frame may set it (the head going down while closed), and only the head
//   coming up clears it (the head pitch against its reference above −5° for 300 ms). A change of gaze source
//   (the hold, then the head fallback) never clears it. Gated, the closure counts only while openness < 0.15
//   (the time of the current run below 0.15), and F1 needs 1.5 s of it.
// - F1 microsleep: counted closure ≥ 1.0 s (1.5 s gated). F2 sleep: ≥ 3.0 s. F3 unresponsive: ≥ 6.0 s, or no
//   on-road gaze within 3.0 s of observed (non-LOST) time after any Critical start. The minimum speeds are
//   config, 0 since Task C2 (the sleep family at every speed, rev4 §2.1.7).
// - Task C2: every F event carries `stopped`, the engine's STOPPED state at the frame that raised it; an
//   `episode_end` is stop-time only if all its F events were (rev5 §4.4) and carries the level reached. F3's
//   no-on-road watch is frozen (not cleared) while STOPPED; it carries the origin of the Critical it
//   escalates (`sleep` after F1/F2/nod, `d4` after D4; sleep dominates).
// - F4 (C-25): two F1 within 10 min → the fatigue level Severe for 15 min; one F1 → at least Drowsy. Task C2
//   (U-14): a stop-time F1 feeds F4 only under fatigue.stopEventsFeed 'all'; under 'long_and_nod' a stop-time
//   episode feeds it once, at its F2 (or F3); under 'none' (the default) nothing stop-time does.
// - A blink is a finished closure episode (duration = reopen − onset); long ≥ 500 ms; counted for the
//   fatigue statistics only when the measured fps ≥ blinkMinFps.
// - A quality drop ends the episode silently: no F rule, no blink. Except C-26: while the conditioner
//   bridges the closure (`closureBridged`), the episode keeps running on the frame clock with the
//   looking-down gate as it stood at the last TRACKING frame; its F events carry `bridged`, and a
//   bridged closure that ends in open eyes is not a blink.
// - One `unresponsive` per Critical episode (T9 review m1): either F3 clause marks the episode and
//   clears the other.
// - `episode_end` (T14 r1 m2): a closure episode that reached F1, F2 or F3 reports its measured length once,
//   when it ends: at the reopening (onset → reopen, as a blink is measured), at a silent end (a quality drop,
//   a frame gap or the end of a bridge: onset → its last closed frame), or at `flush()` (drive end). It is the
//   drowsiness episode the scoring seam samples. F3's no-on-road clause raised outside a closure episode (after
//   the eyes reopened, or after a D4/nod Critical) belongs to no closure episode and ends none.
import type { CriticalOrigin } from './alerts';
import type { Perceived } from './conditioning';
import type { DmsConfig } from './config';
import { createFpsMeter } from './eyes';
import { RingBuffer } from './windows';

export interface FastInput {
  p: Perceived;
  /** ContextState.ruleSpeedKmh; null counts as below 10 */
  ruleSpeedKmh: number | null;
  /**
   * the gaze is on the road (road centre / forward road) with the eyes open; null = no direction is known
   * (no zone: before calibration, or occluded), which neither clears nor counts toward F3's
   * no-on-road clause (Task 12, found by the DMS_FULL property run)
   */
  onRoadGaze: boolean | null;
  /**
   * the measured fps (the façade's fps meter), so the blink `counted` flag and the engine share one meter
   * (final review n1); absent: fastRules keeps its own (unit tests).
   */
  fps?: number;
  /** Task C2: the engine's STOPPED state (ContextState.stopped); absent = moving */
  stopped?: boolean;
}

export type FastEventKind = 'microsleep' | 'sleep' | 'unresponsive' | 'blink' | 'episode_end';

export interface FastEvent {
  kind: FastEventKind;
  tMs: number;
  /** F1–F3 of a closure that was carried across a face loss (C-26) */
  bridged?: boolean;
  /** unresponsive: the F3 clause that raised it (the closure time, or no on-road gaze after a Critical) */
  clause?: 'closure' | 'no_on_road';
  /**
   * unresponsive: it escalates a running Critical (the closure clause in an F1/F2 episode, rev1 I6; the
   * no-on-road clause always), so the alert manager lets it start below 10 km/h (T11 review I1).
   */
  escalation?: boolean;
  /** blinks, and episode_end (the episode's measured length) */
  durMs?: number;
  long?: boolean;
  counted?: boolean;
  /**
   * Task C2: F1–F3, the engine's STOPPED state when raised; episode_end, whether every F event of the
   * episode was stop-time (rev5 §4.4)
   */
  stopped?: boolean;
  /** Task C2: unresponsive, the origin of the Critical (rev4 §2.1.8) */
  origin?: CriticalOrigin;
  /** Task C2: episode_end, the highest F rule the episode reached */
  level?: 'f1' | 'f2' | 'f3';
}

export type FatigueFloor = 'none' | 'drowsy' | 'severe';

const EPS = 1e-6;
/** C2 (rev4 §2.3.6): the latch reads the open-eye frames of this long before onset */
const LATCH_LOOKBACK_MS = 500;
/** C2: the latch clears when the head pitch against its reference is above this for LATCH_CLEAR_MS */
const LATCH_CLEAR_PITCH_DEG = -5;
const LATCH_CLEAR_MS = 300;

export function createFastRules(cfg: DmsConfig) {
  const cl = cfg.closure;
  const feed = cfg.fatigue.stopEventsFeed;
  const fps = createFpsMeter(cfg);
  let episode: {
    onset: number;
    lastT: number;
    deepSince: number | null;
    /** C6 round 1 (C6-2): the episode began in prior mode (no EAR reference): F1 at prior.f1ClosedS, no blink */
    prior: boolean;
    gated: boolean;
    /** C2: the head above the latch's clear pitch since this time (null while it is not) */
    upSince: number | null;
    bridged: boolean;
    f1: boolean;
    f2: boolean;
    f3: boolean;
    /** C2: an F event of this episode was raised while moving */
    anyMoving: boolean;
    /** C2: this episode has fed F4 */
    fedF4: boolean;
  } | null = null;
  /** C2: the recent open-eye frames (time, the per-frame looking-down value) for the latch at onset */
  const openFrames = new RingBuffer<{ t: number; down: boolean }>(64);

  /** Ends the current episode; one that reached F1–F3 reports its length (T14 r1 m2). */
  function endEpisode(events: FastEvent[], tMs: number, durMs: number): void {
    if (episode !== null && (episode.f1 || episode.f2 || episode.f3)) {
      const level = episode.f3 ? 'f3' : episode.f2 ? 'f2' : 'f1';
      events.push({ kind: 'episode_end', tMs, durMs, stopped: !episode.anyMoving, level, ...(episode.bridged ? { bridged: true } : {}) });
    }
    episode = null;
  }
  /** A silent end: the episode lasted to its last closed frame. */
  function endSilently(events: FastEvent[]): void {
    if (episode !== null) endEpisode(events, episode.lastT, episode.lastT - episode.onset);
  }
  /** observed seconds without an on-road gaze since a Critical start; null when none is pending */
  let pendingF3: number | null = null;
  /** C2: the origin of the Critical the watch belongs to (sleep dominates) */
  let pendingOrigin: CriticalOrigin = 'd4';
  const f1Times = new RingBuffer<number>(8);
  let drowsyUntil = Number.NEGATIVE_INFINITY;
  let severeUntil = Number.NEGATIVE_INFINITY;

  function criticalStarted(origin: CriticalOrigin): void {
    pendingOrigin = pendingF3 === null ? origin : pendingOrigin === 'sleep' || origin === 'sleep' ? 'sleep' : 'd4';
    pendingF3 ??= 0;
  }

  /** F4's feed: one F1 (or, under 'long_and_nod', one stop-time F2/F3 episode). */
  function feedF4(tMs: number): void {
    const prior = f1Times.last();
    if (prior !== undefined && tMs - prior <= cl.f4.windowS * 1000) severeUntil = tMs + cl.f4.holdS * 1000;
    drowsyUntil = Math.max(drowsyUntil, tMs + cl.singleF1HoldS * 1000);
    f1Times.push(tMs);
  }

  return {
    /**
     * Any Critical that started elsewhere (D4: `d4`; microsleep_nod: `sleep`): starts the "no on-road gaze"
     * watch, with the origin its escalation inherits.
     */
    criticalStarted,

    /**
     * The alert manager ended the running Critical (its stop condition, or a known low speed): the "no
     * on-road gaze" watch belongs to it and ends too, so it can never raise an escalation of nothing.
     */
    criticalEnded(): void {
      pendingF3 = null;
    },

    fatigueFloor(tMs: number): FatigueFloor {
      if (tMs <= severeUntil) return 'severe';
      if (tMs <= drowsyUntil) return 'drowsy';
      return 'none';
    },

    measuredFps: () => fps.fps(),


    /** Drive end: an F episode still open reports its length so far; the episode ends. */
    flush(): FastEvent[] {
      const events: FastEvent[] = [];
      endSilently(events);
      return events;
    },

    onFrame(x: FastInput): { events: FastEvent[] } {
      const { p } = x;
      const events: FastEvent[] = [];
      if (x.fps === undefined) fps.push(p.tMs);
      const measuredFps = () => x.fps ?? fps.fps();
      const speed = x.ruleSpeedKmh ?? 0;
      const stopped = x.stopped === true;
      // C2: the open-eye frames of the last 500 ms carry the looking-down value the latch reads at onset.
      if (!p.eyesClosed && p.quality === 'tracking') openFrames.push({ t: p.tMs, down: p.lookingDown });
      openFrames.dropWhile((f) => f.t < p.tMs - LATCH_LOOKBACK_MS);

      // Final review I1: a bridge the conditioner ended (its cap, on any frame) ends the bridged episode, so a
      // camera stop inside a bridge is never closure time; a closed eye on this frame starts a new episode.
      if (p.bridgeEnded) endSilently(events);
      // A frame gap ends an unbridged episode silently (T12 review I1) — unless the eyes are still closed on
      // a TRACKING frame after it (final review m1): the episode continues on observed time, its onset
      // shifted by the unobserved span, as the conditioner shifted its closure clock.
      // Round 2: bridged or not, both owners (the conditioner's clock and this episode) shift together.
      // Round 3 (R2-1): the episode follows what the conditioner did: it continues only if the closure did
      // (closed, with closure time kept); a closure the gap ended (or restarted on this frame) ends it.
      if (p.gap && episode !== null) {
        if (p.eyesClosed && p.closedMs > 0) {
          episode.onset += p.unobservedMs;
          if (episode.deepSince !== null) episode.deepSince += p.unobservedMs;
        } else endSilently(events);
      }
      // The episode: TRACKING, or a C-26 bridge; any other quality drop ends it silently.
      if (p.eyesClosed && (p.quality === 'tracking' || p.closureBridged)) {
        if (episode === null) {
          // C2 (S1): the latch at onset, from the open-eye frames of the 500 ms before it.
          const onset = p.tMs - p.closedMs;
          let down = false;
          openFrames.forEach((f) => {
            if (f.t >= onset - LATCH_LOOKBACK_MS && f.t < onset + EPS && f.down) down = true;
          });
          episode = { onset, lastT: p.tMs, deepSince: null, prior: p.priorMode, gated: down, upSince: null, bridged: false, f1: false, f2: false, f3: false, anyMoving: false, fedF4: false };
        }
        episode.lastT = p.tMs;
        if (p.closureBridged) {
          // Through the loss the gate and the deep run stand as at the last TRACKING frame: ungated counts
          // closedMs, a deep run continues, a gated closure that was not deep does not count.
          episode.bridged = true;
        } else {
          // C6 round 1 (C6-2): in prior mode a latched closure is deep below the prior's deep EAR (0.045), on the
          // prior's pseudo-openness.
          const deep = p.priorMode
            ? p.priorOpenness !== null && p.priorOpenness < cl.prior.deepEar / (cl.prior.closedEar / cl.closedBelow)
            : p.openness !== null && p.openness < cl.lookDownClosedBelow;
          if (!deep) episode.deepSince = null;
          else episode.deepSince ??= p.tMs;
          // C2 (S1): a looking-down frame may set the latch; only the head coming up clears it.
          if (p.lookingDown) {
            episode.gated = true;
            episode.upSince = null;
          } else if (episode.gated) {
            const up = p.headRelPitch !== null && p.headRelPitch > LATCH_CLEAR_PITCH_DEG;
            episode.upSince = up ? (episode.upSince ?? p.tMs) : null;
            if (episode.upSince !== null && p.tMs - episode.upSince >= LATCH_CLEAR_MS - EPS) {
              episode.gated = false;
              episode.upSince = null;
            }
          }
        }
        const gated = episode.gated;
        const bridged = episode.bridged ? { bridged: true } : {};
        const countedS = (gated ? (episode.deepSince === null ? 0 : p.tMs - episode.deepSince) : p.closedMs) / 1000;
        const f1S = episode.prior ? Math.max(cl.prior.f1ClosedS, gated ? cl.f1.lookDownClosedS : 0) : gated ? cl.f1.lookDownClosedS : cl.f1.closedS;
        if (!episode.f1 && countedS >= f1S - EPS && speed >= cl.f1.minSpeedKmh) {
          episode.f1 = true;
          if (!stopped) episode.anyMoving = true;
          events.push({ kind: 'microsleep', tMs: p.tMs, stopped, ...bridged });
          criticalStarted('sleep');
          // C2 (U-14): a stop-time F1 feeds F4 only under 'all'.
          if (!stopped || feed === 'all') {
            episode.fedF4 = true;
            feedF4(p.tMs);
          }
        }
        if (!episode.f2 && countedS >= cl.f2.closedS - EPS && speed >= cl.f2.minSpeedKmh) {
          episode.f2 = true;
          if (!stopped) episode.anyMoving = true;
          events.push({ kind: 'sleep', tMs: p.tMs, stopped, ...bridged });
          criticalStarted('sleep');
          if (stopped && feed === 'long_and_nod' && !episode.fedF4) {
            episode.fedF4 = true;
            feedF4(p.tMs);
          }
        }
        const escalation = episode.f1 || episode.f2;
        if (!episode.f3 && countedS >= cl.f3.closedS - EPS && (speed >= cl.f3.minSpeedKmh || escalation)) {
          episode.f3 = true;
          if (!stopped) episode.anyMoving = true;
          pendingF3 = null;
          events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'closure', escalation: escalation, stopped, origin: 'sleep', ...bridged });
          if (stopped && feed === 'long_and_nod' && !episode.fedF4) {
            episode.fedF4 = true;
            feedF4(p.tMs);
          }
        }
      } else if (episode !== null && p.quality === 'tracking' && !episode.bridged) {
        const durMs = p.tMs - episode.onset;
        // C6 round 1 (C6-2): a prior-mode closure is no blink (the prior feeds no fatigue statistic).
        if (!episode.prior) events.push({ kind: 'blink', tMs: p.tMs, durMs, long: durMs >= cl.longBlinkMs, counted: measuredFps() >= cl.blinkMinFps });
        endEpisode(events, p.tMs, durMs);
      } else {
        endSilently(events); // a quality drop, or the end of a bridged closure: silent (no blink)
      }

      // F3's second clause: no on-road gaze within 3.0 s of observed time after a Critical start. C2: frozen
      // (neither cleared nor counting) while STOPPED; it resumes after the move-off.
      if (pendingF3 !== null && !stopped && !events.some((e) => e.kind === 'microsleep' || e.kind === 'sleep')) {
        if (x.onRoadGaze === true) pendingF3 = null;
        else if (x.onRoadGaze === false && p.quality !== 'lost') {
          pendingF3 += p.gap ? 0 : p.dtS; // observed time only (T12 review I1)
          if (pendingF3 >= cl.f3.noOnRoadS - EPS) {
            pendingF3 = null;
            if (episode !== null) {
              episode.f3 = true;
              episode.anyMoving = true;
            }
            events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'no_on_road', escalation: true, stopped: false, origin: pendingOrigin, ...(episode?.bridged === true ? { bridged: true } : {}) });
          }
        }
      }
      return { events };
    },
  };
}
