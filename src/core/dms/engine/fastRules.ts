// The fast drowsiness rules (plan §M6; spec "Fast rules"). Closure itself (openness by the max usable
// eye, the near eye past 25°, 0.30/0.45 hysteresis, TRACKING only) is the conditioner's; this file turns
// closure episodes into F1–F4 and blinks. Pure.
//
// - The looking-down gate: on a frame whose rel pitch is below −15°, the closure counts only while
//   openness < 0.15 (the time of the current run below 0.15), and F1 needs 1.5 s of it.
// - F1 microsleep: counted closure ≥ 1.0 s (1.5 s gated) at ≥ 20 km/h. F2 sleep: ≥ 3.0 s at ≥ 10 km/h.
//   F3 unresponsive: ≥ 6.0 s at ≥ 10 km/h (or at any speed once F1/F2 is active: an escalation), or no
//   on-road gaze within 3.0 s of observed (non-LOST) time after any Critical start.
// - F4 (C-25): two F1 within 10 min → the fatigue level Severe for 15 min; one F1 → at least Drowsy.
// - A blink is a finished closure episode (duration = reopen − onset); long ≥ 500 ms; counted for the
//   fatigue statistics only when the measured fps ≥ blinkMinFps.
// - A quality drop ends the episode silently: no F rule, no blink. Except C-26: while the conditioner
//   bridges the closure (`closureBridged`), the episode keeps running on the frame clock with the
//   looking-down gate as it stood at the last TRACKING frame; its F events carry `bridged`, and a
//   bridged closure that ends in open eyes is not a blink.
// - One `unresponsive` per Critical episode (T9 review m1): either F3 clause marks the episode and
//   clears the other.
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
}

export type FastEventKind = 'microsleep' | 'sleep' | 'unresponsive' | 'blink';

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
  /** blinks */
  durMs?: number;
  long?: boolean;
  counted?: boolean;
}

export type FatigueFloor = 'none' | 'drowsy' | 'severe';

const EPS = 1e-6;

export function createFastRules(cfg: DmsConfig) {
  const cl = cfg.closure;
  const fps = createFpsMeter(cfg);
  let episode: { onset: number; deepSince: number | null; gated: boolean; bridged: boolean; f1: boolean; f2: boolean; f3: boolean } | null = null;
  /** observed seconds without an on-road gaze since a Critical start; null when none is pending */
  let pendingF3: number | null = null;
  const f1Times = new RingBuffer<number>(8);
  let drowsyUntil = Number.NEGATIVE_INFINITY;
  let severeUntil = Number.NEGATIVE_INFINITY;

  function criticalStarted(): void {
    pendingF3 ??= 0;
  }

  return {
    /** Any Critical that started elsewhere (D4, microsleep_nod): starts the "no on-road gaze" watch. */
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

    onFrame(x: FastInput): { events: FastEvent[] } {
      const { p } = x;
      const events: FastEvent[] = [];
      fps.push(p.tMs);
      const speed = x.ruleSpeedKmh ?? 0;

      // The episode: TRACKING, or a C-26 bridge; any other quality drop ends it silently.
      if (p.eyesClosed && (p.quality === 'tracking' || p.closureBridged)) {
        episode ??= { onset: p.tMs - p.closedMs, deepSince: null, gated: false, bridged: false, f1: false, f2: false, f3: false };
        if (p.closureBridged) {
          // Through the loss the gate and the deep run stand as at the last TRACKING frame: ungated counts
          // closedMs, a deep run continues, a gated closure that was not deep does not count.
          episode.bridged = true;
        } else {
          const deep = p.openness !== null && p.openness < cl.lookDownClosedBelow;
          if (!deep) episode.deepSince = null;
          else episode.deepSince ??= p.tMs;
          episode.gated = p.lookingDown;
        }
        const gated = episode.gated;
        const bridged = episode.bridged ? { bridged: true } : {};
        const countedS = (gated ? (episode.deepSince === null ? 0 : p.tMs - episode.deepSince) : p.closedMs) / 1000;
        const f1S = gated ? cl.f1.lookDownClosedS : cl.f1.closedS;
        if (!episode.f1 && countedS >= f1S - EPS && speed >= cl.f1.minSpeedKmh) {
          episode.f1 = true;
          events.push({ kind: 'microsleep', tMs: p.tMs, ...bridged });
          criticalStarted();
          const prior = f1Times.last();
          if (prior !== undefined && p.tMs - prior <= cl.f4.windowS * 1000) severeUntil = p.tMs + cl.f4.holdS * 1000;
          drowsyUntil = Math.max(drowsyUntil, p.tMs + cl.singleF1HoldS * 1000);
          f1Times.push(p.tMs);
        }
        if (!episode.f2 && countedS >= cl.f2.closedS - EPS && speed >= cl.f2.minSpeedKmh) {
          episode.f2 = true;
          events.push({ kind: 'sleep', tMs: p.tMs, ...bridged });
          criticalStarted();
        }
        const escalation = episode.f1 || episode.f2;
        if (!episode.f3 && countedS >= cl.f3.closedS - EPS && (speed >= cl.f3.minSpeedKmh || escalation)) {
          episode.f3 = true;
          pendingF3 = null;
          events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'closure', escalation: escalation, ...bridged });
        }
      } else if (episode !== null && p.quality === 'tracking' && !episode.bridged) {
        const durMs = p.tMs - episode.onset;
        events.push({ kind: 'blink', tMs: p.tMs, durMs, long: durMs >= cl.longBlinkMs, counted: fps.fps() >= cl.blinkMinFps });
        episode = null;
      } else {
        episode = null; // a quality drop, or the end of a bridged closure: silent
      }

      // F3's second clause: no on-road gaze within 3.0 s of observed time after a Critical start.
      if (pendingF3 !== null && !events.some((e) => e.kind === 'microsleep' || e.kind === 'sleep')) {
        if (x.onRoadGaze === true) pendingF3 = null;
        else if (x.onRoadGaze === false && p.quality !== 'lost') {
          pendingF3 += p.dtS;
          if (pendingF3 >= cl.f3.noOnRoadS - EPS) {
            pendingF3 = null;
            if (episode !== null) episode.f3 = true;
            events.push({ kind: 'unresponsive', tMs: p.tMs, clause: 'no_on_road', escalation: true, ...(episode?.bridged === true ? { bridged: true } : {}) });
          }
        }
      }
      return { events };
    },
  };
}
