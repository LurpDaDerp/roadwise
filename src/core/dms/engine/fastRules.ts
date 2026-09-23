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
// - A quality drop ends the episode silently: no F rule, no blink.
import type { Perceived } from './conditioning';
import type { DmsConfig } from './config';
import { createFpsMeter } from './eyes';
import { RingBuffer } from './windows';

export interface FastInput {
  p: Perceived;
  /** ContextState.ruleSpeedKmh; null counts as below 10 */
  ruleSpeedKmh: number | null;
  /** the gaze is on the road (road centre / forward road) with the eyes open */
  onRoadGaze: boolean;
}

export type FastEventKind = 'microsleep' | 'sleep' | 'unresponsive' | 'blink';

export interface FastEvent {
  kind: FastEventKind;
  tMs: number;
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
  let episode: { onset: number; deepSince: number | null; f1: boolean; f2: boolean; f3: boolean } | null = null;
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

      // The episode: TRACKING only; a quality drop ends it silently.
      if (p.quality !== 'tracking') {
        episode = null;
      } else if (p.eyesClosed) {
        episode ??= { onset: p.tMs - p.closedMs, deepSince: null, f1: false, f2: false, f3: false };
        const deep = p.openness !== null && p.openness < cl.lookDownClosedBelow;
        if (!deep) episode.deepSince = null;
        else episode.deepSince ??= p.tMs;
        const gated = p.lookingDown;
        const countedS = (gated ? (episode.deepSince === null ? 0 : p.tMs - episode.deepSince) : p.closedMs) / 1000;
        const f1S = gated ? cl.f1.lookDownClosedS : cl.f1.closedS;
        if (!episode.f1 && countedS >= f1S - EPS && speed >= cl.f1.minSpeedKmh) {
          episode.f1 = true;
          events.push({ kind: 'microsleep', tMs: p.tMs });
          criticalStarted();
          const prior = f1Times.last();
          if (prior !== undefined && p.tMs - prior <= cl.f4.windowS * 1000) severeUntil = p.tMs + cl.f4.holdS * 1000;
          drowsyUntil = Math.max(drowsyUntil, p.tMs + cl.singleF1HoldS * 1000);
          f1Times.push(p.tMs);
        }
        if (!episode.f2 && countedS >= cl.f2.closedS - EPS && speed >= cl.f2.minSpeedKmh) {
          episode.f2 = true;
          events.push({ kind: 'sleep', tMs: p.tMs });
          criticalStarted();
        }
        const escalation = episode.f1 || episode.f2;
        if (!episode.f3 && countedS >= cl.f3.closedS - EPS && (speed >= cl.f3.minSpeedKmh || escalation)) {
          episode.f3 = true;
          events.push({ kind: 'unresponsive', tMs: p.tMs });
        }
      } else if (episode !== null) {
        const durMs = p.tMs - episode.onset;
        events.push({ kind: 'blink', tMs: p.tMs, durMs, long: durMs >= cl.longBlinkMs, counted: fps.fps() >= cl.blinkMinFps });
        episode = null;
      }

      // F3's second clause: no on-road gaze within 3.0 s of observed time after a Critical start.
      if (pendingF3 !== null && !events.some((e) => e.kind === 'microsleep' || e.kind === 'sleep')) {
        if (x.onRoadGaze) pendingF3 = null;
        else if (p.quality !== 'lost') {
          pendingF3 += p.dtS;
          if (pendingF3 >= cl.f3.noOnRoadS - EPS) {
            pendingF3 = null;
            events.push({ kind: 'unresponsive', tMs: p.tMs });
          }
        }
      }
      return { events };
    },
  };
}
