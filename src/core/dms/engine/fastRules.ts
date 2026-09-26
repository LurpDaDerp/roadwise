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

/**
 * C7 round 6 (review-C7 R4-T, the user's decision): `eyes_off` is a shallow closure while moving at ≥ 20 km/h (never
 * deep for shallowDeepMs, unlatched) that reached F1's time: the eyes are not on the road, which is not sleep. It
 * becomes a Tier 2 "eyes on the road" alert; F1/F2 wait for a deep run, F3 still fires at 6 s.
 */
export type FastEventKind = 'microsleep' | 'sleep' | 'unresponsive' | 'blink' | 'episode_end' | 'eyes_off';

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
  /**
   * C7 round 1 (review-C7 C7-4): an F event raised while moving in an episode that was never deep (openness under
   * lookDownClosedBelow for shallowDeepMs) up to it. It is delivered (a sleep alert), but feeds neither F4, the
   * fatigue floor, the fatigue gate nor the drowsiness score. On episode_end: every F event of it was shallow.
   */
  shallow?: boolean;
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

/** C7 round 4 (review-C7 R3-M): the median of up to 3 values; the last value itself until there are 3. */
export function median3(xs: readonly number[]): number {
  if (xs.length < 3) return xs[xs.length - 1]!;
  const [a, b, c] = xs as [number, number, number];
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export function createFastRules(cfg: DmsConfig) {
  const cl = cfg.closure;
  const la = cl.latch;
  const feed = cfg.fatigue.stopEventsFeed;
  /** Task C7 (R-a): the last raw gaze-down frame (the noise guard at ≥ rawGuardMinFps) */
  let lastRawDownT: number | null = null;
  const fps = createFpsMeter(cfg);
  let episode: {
    onset: number;
    lastT: number;
    deepSince: number | null;
    /**
     * C7 round 3 (review-C7 R2-S): the bridged deep run for deep-only counting (latched, or stopped): its first deep
     * frame, its last deep frame, and the start of the current non-deep stretch within it. A non-deep stretch of
     * ≤ closure.deepBridgeMs (the eye still closed) is bridged; a longer one breaks the run. Its time is the run's
     * elapsed time to its last deep frame (a noisy closed lid flickering over 0.15 is still one closure).
     */
    dRunStart: number | null;
    dLastDeepT: number | null;
    dNonDeepSince: number | null;
    /** C6 round 1 (C6-2): the episode began in prior mode (no EAR reference): F1 at prior.f1ClosedS, no blink */
    prior: boolean;
    /**
     * C6 round 3 (review-C6 R2-F): the prior's deep run, ms of deep frames' observed time; null when there is none.
     * A non-deep stretch of ≤ prior.reopenMs is bridged (it adds nothing); a longer one breaks the run.
     */
    pRunMs: number | null;
    /** the last deep frame of the run (null in none) */
    pLastDeepT: number | null;
    /** the start of the current non-deep stretch within the run (null while deep) */
    pNonDeepSince: number | null;
    gated: boolean;
    /** C7 round 5 (review-C7 Round 4, should-fix): the episode was latched at any point (its blink is its deep run) */
    everGated: boolean;
    /**
     * C7 round 1 (review-C7 C7-1, C7-2): what set the latch; each clears on evidence of its own kind. `lGaze`: the
     * gaze or R-a (clears on a reliable raw frame back up, or the head risen above its onset pitch); `lHead`: the
     * head fallback (clears on the head above clearPitchDeg); `lRb`: R-b (clears on the head back near `preMed`).
     */
    lGaze: boolean;
    lHead: boolean;
    lRb: boolean;
    /** the head pitch (driver frame) at the onset, and the median over the stopPreOnsetS before it (R-b's reference) */
    onsetHead: number | null;
    preMed: number | null;
    /** C2: the head above the latch's clear pitch since this time (null while it is not) */
    upSince: number | null;
    /** C7 round 1: the head risen headRiseDeg above its onset pitch since (the gaze latch's clear) */
    riseSince: number | null;
    /** C7 round 1: the head back within stopReturnDeg of preMed since (R-b's clear) */
    rbSince: number | null;
    /** C7 round 1 (C7-4): the longest deep run so far, ms; an F event raised moving before shallowDeepMs is shallow */
    deepMaxMs: number;
    /**
     * C7 round 4 (review-C7 R3-M): the episode's last 3 openness values. "Deep" is decided on their median (the
     * frame's own value until there are 3), so a lid's per-frame EAR noise does not flicker a reading lid 0.02 above
     * the threshold into deep time.
     */
    lastOpen: number[];
    /** C7 round 4: the median of lastOpen at the last frame (null before the first openness) */
    medOpen: number | null;
    /**
     * C7 round 4 (review-C7 Round 4 ruling, A): the episode's closedMs when its latch last cleared with the episode
     * continuing. The ungated count is closedMs since then: the time already latched was explained by the
     * looking-down evidence and never counts (a reader's lagging lid at the look-up).
     */
    closedAtClear: number | null;
    /** C7 round 1: F events of this episode, and how many were shallow */
    fCount: number;
    fShallow: number;
    bridged: boolean;
    f1: boolean;
    /** C7 round 6 (R4-T): an eyes-off alert was raised in this episode (F1/F2 then count its deep run only) */
    eyesOff: boolean;
    f2: boolean;
    f3: boolean;
    /** C2: an F event of this episode was raised while moving */
    anyMoving: boolean;
    /** C2: this episode has fed F4 */
    fedF4: boolean;
  } | null = null;
  /** C2: the recent open-eye frames (time, the per-frame looking-down value and its kind) for the latch at onset */
  const openFrames = new RingBuffer<{ t: number; gaze: boolean; head: boolean }>(64);
  /** C7 round 1 (C7-2): the recent TRACKING head pitches (driver frame), for R-b's pre-onset median */
  const headHist = new RingBuffer<{ t: number; pitch: number }>(128);

  /** Ends the current episode; one that reached F1–F3 reports its length (T14 r1 m2). */
  function endEpisode(events: FastEvent[], tMs: number, durMs: number): void {
    if (episode !== null && (episode.f1 || episode.f2 || episode.f3)) {
      const level = episode.f3 ? 'f3' : episode.f2 ? 'f2' : 'f1';
      const shallow = episode.fCount > 0 && episode.fShallow === episode.fCount;
      events.push({ kind: 'episode_end', tMs, durMs, stopped: !episode.anyMoving, level, ...(episode.bridged ? { bridged: true } : {}), ...(shallow ? { shallow: true } : {}) });
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

  /** C7 round 1 (C7-4): every Critical the pending no-on-road watch belongs to was a shallow F event */
  let pendingShallow = false;
  function criticalStarted(origin: CriticalOrigin, shallow = false): void {
    pendingOrigin = pendingF3 === null ? origin : pendingOrigin === 'sleep' || origin === 'sleep' ? 'sleep' : 'd4';
    pendingShallow = pendingF3 === null ? shallow : pendingShallow && shallow;
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
    episodeGated: () => episode !== null && episode.gated,
    /**
     * C7 round 4 (review-C7 R3-M): the openness PERCLOS compares with its 0.15 threshold inside a latched episode,
     * the median of the episode's last 3 values (null: no episode, or no openness yet).
     */
    deepOpenness: () => (episode === null ? null : episode.medOpen),


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
      // Task C7 (review-C2 §3 R-a): a frame reads "down" for the latch by today's per-frame value, or by the RAW gaze
      // (reliable-eye frames only) below the gate pitch; at ≥ rawGuardMinFps a raw frame needs another within
      // rawGuardMs (a single σ-4° outlier is not a look down).
      const rawDown = p.gazeRelRawPitch !== null && p.gazeRelRawPitch < cl.lookDownRelPitchDeg;
      // The T7 pre-ruling: one raw frame far beyond noise (p.gazeRawSingleDown) is enough on its own.
      const guarded = rawDown && (p.gazeRawSingleDown || measuredFps() < la.rawGuardMinFps || (lastRawDownT !== null && p.tMs - lastRawDownT <= la.rawGuardMs + EPS));
      if (rawDown) lastRawDownT = p.tMs;
      // C7 round 1 (C7-1): the kind of evidence: the gaze (a gaze frame, or R-a) or the head (the head fallback).
      const gazeDown = (p.lookingDown && p.lookingDownFrom !== 'head') || guarded;
      const headDown = p.lookingDown && p.lookingDownFrom === 'head';
      // C2: the open-eye frames of the lookback carry the looking-down value the latch reads at onset.
      if (!p.eyesClosed && p.quality === 'tracking') openFrames.push({ t: p.tMs, gaze: gazeDown, head: headDown });
      // C7 round 4: the lookback spans at least lookbackFrames frame intervals. The noise-corrected reference (B)
      // reads a lowering lid about 4 % more open, so at 5 fps with a lagging lid the closure starts a frame later,
      // and the 500 ms lookback lost the reading saccade's gaze frame (S-READING-LEVELHEAD at 5 fps).
      const fpsNow = measuredFps();
      const lookback = Math.max(la.lookbackMs, fpsNow > 0 ? (la.lookbackFrames * 1000) / fpsNow : 0);
      openFrames.dropWhile((f) => f.t < p.tMs - lookback);
      if (p.quality === 'tracking' && p.headDrv !== null) headHist.push({ t: p.tMs, pitch: p.headDrv.pitch });
      headHist.dropWhile((h) => h.t < p.tMs - (la.stopPreOnsetS + 2) * 1000);

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
          if (episode.dRunStart !== null) episode.dRunStart += p.unobservedMs;
          if (episode.dLastDeepT !== null) episode.dLastDeepT += p.unobservedMs;
          if (episode.dNonDeepSince !== null) episode.dNonDeepSince += p.unobservedMs;
          if (episode.pLastDeepT !== null) episode.pLastDeepT += p.unobservedMs;
          if (episode.pNonDeepSince !== null) episode.pNonDeepSince += p.unobservedMs;
        } else endSilently(events);
      }
      // The episode: TRACKING, or a C-26 bridge; any other quality drop ends it silently.
      if (p.eyesClosed && (p.quality === 'tracking' || p.closureBridged)) {
        if (episode === null) {
          // C2 (S1): the latch at onset, from the open-eye frames of the 500 ms before it.
          const onset = p.tMs - p.closedMs;
          let gazeAtOnset = false;
          let headAtOnset = false;
          openFrames.forEach((f) => {
            if (f.t >= onset - lookback - EPS && f.t < onset + EPS) {
              gazeAtOnset ||= f.gaze;
              headAtOnset ||= f.head;
            }
          });
          // C7 round 1 (C7-2): R-b's reference, the head's own median over the stopPreOnsetS before onset.
          const pre: number[] = [];
          headHist.forEach((h) => {
            if (h.t >= onset - la.stopPreOnsetS * 1000 - EPS && h.t < onset - EPS) pre.push(h.pitch);
          });
          pre.sort((a, b) => a - b);
          const preMed = pre.length > 0 ? pre[pre.length >> 1]! : null;
          episode = {
            onset,
            lastT: p.tMs,
            deepSince: null,
            dRunStart: null,
            dLastDeepT: null,
            dNonDeepSince: null,
            prior: p.priorMode,
            pRunMs: null,
            pLastDeepT: null,
            pNonDeepSince: null,
            gated: gazeAtOnset || headAtOnset,
            everGated: gazeAtOnset || headAtOnset,
            lGaze: gazeAtOnset,
            lHead: headAtOnset,
            lRb: false,
            onsetHead: p.headDrv?.pitch ?? null,
            preMed,
            upSince: null,
            riseSince: null,
            rbSince: null,
            deepMaxMs: 0,
            lastOpen: [],
            medOpen: null,
            closedAtClear: null,
            fCount: 0,
            fShallow: 0,
            bridged: false,
            f1: false,
            eyesOff: false,
            f2: false,
            f3: false,
            anyMoving: false,
            fedF4: false,
          };
        }
        episode.lastT = p.tMs;
        if (p.closureBridged) {
          // Through the loss the gate and the deep run stand as at the last TRACKING frame: ungated counts
          // closedMs, a deep run continues, a gated closure that was not deep does not count.
          episode.bridged = true;
        } else {
          // C6 round 1 (C6-2): in prior mode deep is below the prior's deep EAR (0.045), on the prior's pseudo-openness.
          // C6 round 2 (review-C6 R1-P): and in prior mode every closure counts deep time only (below).
          // C7 round 4 (review-C7 R3-M): outside prior mode, deep is decided on the median of the last 3 openness values.
          if (p.openness !== null) {
            episode.lastOpen.push(p.openness);
            if (episode.lastOpen.length > 3) episode.lastOpen.shift();
            episode.medOpen = median3(episode.lastOpen);
          }
          const deep = p.priorMode
            ? p.priorOpenness !== null && p.priorOpenness < cl.prior.deepEar / (cl.prior.closedEar / cl.closedBelow)
            : p.openness !== null && episode.medOpen !== null && episode.medOpen < cl.lookDownClosedBelow;
          if (!deep) episode.deepSince = null;
          else episode.deepSince ??= p.tMs;
          // C7 round 3 (R2-S): the bridged deep run (its length also measures "deep" for C7-4 and R1-F).
          if (deep) {
            episode.dRunStart ??= p.tMs;
            episode.dLastDeepT = p.tMs;
            episode.dNonDeepSince = null;
            episode.deepMaxMs = Math.max(episode.deepMaxMs, p.tMs - episode.dRunStart);
          } else if (episode.dRunStart !== null) {
            episode.dNonDeepSince ??= p.tMs;
            if (p.tMs - episode.dNonDeepSince > cl.deepBridgeMs + EPS) {
              episode.dRunStart = null;
              episode.dLastDeepT = null;
              episode.dNonDeepSince = null;
            }
          }
          // C6 round 3 (review-C6 R2-F): the prior's run bridges a non-deep stretch of ≤ reopenMs (a flutter that keeps
          // the closure open must not restart the count); the counted time is the deep frames' observed time.
          if (episode.prior) {
            if (deep) {
              if (episode.pRunMs === null) episode.pRunMs = 0;
              else if (episode.pNonDeepSince === null && episode.pLastDeepT !== null) episode.pRunMs += p.tMs - episode.pLastDeepT;
              episode.pLastDeepT = p.tMs;
              episode.pNonDeepSince = null;
            } else if (episode.pRunMs !== null) {
              episode.pNonDeepSince ??= p.tMs;
              if (p.tMs - episode.pNonDeepSince > cl.prior.reopenMs + EPS) {
                episode.pRunMs = null;
                episode.pLastDeepT = null;
                episode.pNonDeepSince = null;
              }
            }
          }
          // C2 (S1): a looking-down frame may set the latch. C7 round 1 (review-C7): every latch clears on evidence of
          // the kind that set it (C7-1), and R-b is relative to the head's own pre-onset median (C7-2).
          const held = (since: number | null) => since !== null && p.tMs - since >= la.clearHoldMs - EPS;
          const head = p.headDrv?.pitch ?? null;
          if (gazeDown) {
            episode.lGaze = true;
            episode.riseSince = null;
          } else if (episode.lGaze) {
            // The gaze latch: a reliable raw frame back above −12° (the iris seen and up), or the head risen.
            const rawUp = p.gazeRelRawPitch !== null && p.gazeRelRawPitch > cl.lookDownRelPitchDeg + la.gazeClearMarginDeg;
            const risen = head !== null && episode.onsetHead !== null && head >= episode.onsetHead + la.headRiseDeg;
            episode.riseSince = risen ? (episode.riseSince ?? p.tMs) : null;
            if (rawUp || held(episode.riseSince)) {
              episode.lGaze = false;
              episode.riseSince = null;
            }
          }
          if (headDown) {
            episode.lHead = true;
            episode.upSince = null;
          } else if (episode.lHead) {
            const up = p.headRelPitch !== null && p.headRelPitch > la.clearPitchDeg;
            episode.upSince = up ? (episode.upSince ?? p.tMs) : null;
            if (held(episode.upSince)) {
              episode.lHead = false;
              episode.upSince = null;
            }
          }
          // R-b (STOPPED only): the head stopDipDeg below its pre-onset median within the first stopSetWindowS (a fast
          // lid or a blink on the saccade leaves no gaze to read; an eye-mover's head still dips a little).
          const dipped = stopped && p.tMs - episode.onset <= la.stopSetWindowS * 1000 + EPS && head !== null && episode.preMed !== null && head <= episode.preMed - la.stopDipDeg;
          if (dipped) {
            episode.lRb = true;
            episode.rbSince = null;
          } else if (episode.lRb) {
            const back = head !== null && episode.preMed !== null && head >= episode.preMed - la.stopReturnDeg;
            episode.rbSince = back ? (episode.rbSince ?? p.tMs) : null;
            if (held(episode.rbSince)) {
              episode.lRb = false;
              episode.rbSince = null;
            }
          }
          const wasGated = episode.gated;
          episode.gated = episode.lGaze || episode.lHead || episode.lRb;
          if (wasGated && !episode.gated) episode.closedAtClear = p.closedMs;
          if (episode.gated) episode.everGated = true;
        }
        const gated = episode.gated;
        const bridged = episode.bridged ? { bridged: true } : {};
        // C6 round 2 (review-C6 R1-P): a prior-mode episode counts deep time only, latched or not. Before any pitch
        // reference or centre the looking-down gate cannot be measured, and a steep reading lid (the synth's floor,
        // EAR ≈ 0.051) lies between the deep EAR and the closed EAR; a full closure (EAR ≈ 0.02–0.04) is deep.
        // C6 round 3 (R2-F): its deep time is the bridged run's.
        // C7 round 2 (the coordinator's stop ruling, review-C7 Round 1 §3 option b): while STOPPED every closure counts
        // deep-only, as if latched (F1 at 1.5 s of openness < 0.15): a reader at a light with no iris and no head dip
        // is never alarmed; real sleep is deep and still is (+0.5 s at a light).
        // C7 round 5 (review-C7 R4-C): and in the moving crawl band (rule speed below closure.deepOnlyBelowKmh, 20): the
        // capture runs 5 fps there (SLEEP_WATCH), so a fast lid leaves no gaze frame and a phone reader in stop-and-go
        // traffic would get a sleep Critical on every bout; real sleep is deep, at +0.5 s as at a light.
        const crawl = x.ruleSpeedKmh !== null && x.ruleSpeedKmh < cl.deepOnlyBelowKmh - EPS;
        const deepOnly = gated || stopped || crawl;
        // C7 round 3 (R2-S): deep-only counting uses the bridged run (a single frame at 0.15 no longer restarts it).
        // Through a C-26 bridge the run stands as at the last TRACKING frame and keeps running (as the deep run did).
        const runEnd = p.closureBridged && episode.dNonDeepSince === null ? p.tMs : episode.dLastDeepT;
        const runMs = episode.dRunStart === null || runEnd === null ? 0 : runEnd - episode.dRunStart;
        // C7 round 4 (A): after a latch clears, the ungated count is the closure since the clear.
        const ungatedMs = Math.max(0, p.closedMs - (episode.closedAtClear ?? 0));
        const countedS = (episode.prior ? (episode.pRunMs ?? 0) : deepOnly ? runMs : ungatedMs) / 1000;
        const f1S = episode.prior ? Math.max(cl.prior.f1ClosedS, gated ? cl.f1.lookDownClosedS : 0) : deepOnly ? cl.f1.lookDownClosedS : cl.f1.closedS;
        // C7 round 1 (review-C7 C7-4): moving, and never deep for shallowDeepMs: the event is marked shallow.
        const shallow = !stopped && episode.deepMaxMs < cl.shallowDeepMs - EPS;
        const mark = (sh: boolean) => {
          episode!.fCount++;
          if (sh) episode!.fShallow++;
          return sh ? { shallow: true } : {};
        };
        // C7 round 6 (review-C7 R4-T, the user's decision): while moving at ≥ 20 km/h, an unlatched closure that has not
        // been deep for shallowDeepMs is "eyes off the road", not sleep. At F1's time it raises one eyes_off (a Tier 2
        // alert); F1 and F2 then wait for the bridged median-3 deep run to reach their times (a real closure turning
        // deep), and F3 still fires at f3.closedS of closure (6 s).
        const eyesOffMode = !deepOnly && !episode.prior && speed >= cl.deepOnlyBelowKmh - EPS && episode.deepMaxMs < cl.shallowDeepMs - EPS;
        if (eyesOffMode && !episode.eyesOff && ungatedMs / 1000 >= cl.f1.closedS - EPS) {
          episode.eyesOff = true;
          events.push({ kind: 'eyes_off', tMs: p.tMs, ...bridged });
        }
        const f12S = episode.eyesOff ? runMs / 1000 : countedS;
        if (!episode.f1 && !eyesOffMode && f12S >= f1S - EPS && speed >= cl.f1.minSpeedKmh) {
          episode.f1 = true;
          if (!stopped) episode.anyMoving = true;
          events.push({ kind: 'microsleep', tMs: p.tMs, stopped, ...bridged, ...mark(shallow) });
          criticalStarted('sleep', shallow);
          // C2 (U-14): a stop-time F1 feeds F4 only under 'all'. C7 round 1: a shallow one never does.
          if (!shallow && (!stopped || feed === 'all')) {
            episode.fedF4 = true;
            feedF4(p.tMs);
          }
        }
        if (!episode.f2 && !eyesOffMode && f12S >= cl.f2.closedS - EPS && speed >= cl.f2.minSpeedKmh) {
          episode.f2 = true;
          if (!stopped) episode.anyMoving = true;
          events.push({ kind: 'sleep', tMs: p.tMs, stopped, ...bridged, ...mark(shallow) });
          criticalStarted('sleep', shallow);
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
          events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'closure', escalation: escalation, stopped, origin: 'sleep', ...bridged, ...mark(shallow) });
          if (stopped && feed === 'long_and_nod' && !episode.fedF4) {
            episode.fedF4 = true;
            feedF4(p.tMs);
          }
        }
      } else if (episode !== null && p.quality === 'tracking' && !episode.bridged) {
        const durMs = p.tMs - episode.onset;
        // C6 round 1 (C6-2): a prior-mode closure is no blink (the prior feeds no fatigue statistic).
        // C7 round 2 (review-C7 R1-F): a closure of ≥ longBlinkMs that was never deep for shallowDeepMs (a reading lid,
        // latched or not) is no blink: neither a long blink nor a blink-duration sample. Shorter ones are blinks.
        const notABlink = durMs >= cl.longBlinkMs && episode.deepMaxMs < cl.shallowDeepMs - EPS;
        // C7 round 5 (review-C7 Round 4, should-fix): in an episode latched at any point, the blink is its longest
        // bridged deep run (a reading episode that holds a natural blink is that blink, not a 3–8 s long blink).
        const blinkMs = episode.everGated ? episode.deepMaxMs : durMs;
        const isBlink = episode.everGated ? episode.deepMaxMs > EPS : !notABlink;
        if (!episode.prior && isBlink) events.push({ kind: 'blink', tMs: p.tMs, durMs: blinkMs, long: blinkMs >= cl.longBlinkMs, counted: measuredFps() >= cl.blinkMinFps });
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
            // C7 round 1 (C7-4): the escalation of shallow F events only is shallow too.
            if (episode !== null) {
              episode.fCount++;
              if (pendingShallow) episode.fShallow++;
            }
            events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'no_on_road', escalation: true, stopped: false, origin: pendingOrigin, ...(episode?.bridged === true ? { bridged: true } : {}), ...(pendingShallow ? { shallow: true } : {}) });
          }
        }
      }
      return { events };
    },
  };
}
