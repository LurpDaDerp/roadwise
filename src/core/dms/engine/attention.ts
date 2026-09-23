// The distraction rules (plan §M5; spec Rules D1–D4): the angle-weighted attention buffer, VATS with its
// reset (rev1 I1, C-21), the phone pattern and the unresponsive escalation. Pure; time is the frame clock.
//
// D1: f ∈ [0, 1] from 1. B = 6.0 s (20–50 km/h) or 3.0 s (≥ 50), × sensitivity (Low capped at ADDW).
//   Off-road, after the zone's grace within this glance, f falls by weight × dt / B; back on road it holds
//   for 100 ms, then rises by dt / B. Below 20 km/h it never drains. Occlusion, SEARCH and handling
//   freeze it. It warns at 0 and re-arms at ≥ 0.5. A change of B keeps f.
// D2: non-driving time (not mirrors, the cluster or shoulder checks) in 100 ms buckets over 30 s; ≥ 2.0 s
//   continuously on road centre or forward road RESETS it; it warns at ≥ 10.0 s, re-armed by a reset.
// D3: ≥ 3 glances with ≥ 1.0 s of lap time whose starts fall within 30 s → one phone_pattern, at most
//   once per 10 min.
// D4: after a D1/D2 warning, 3.0 s of OBSERVED off-road time (non-null, non-on-road zones, incl. C-8's
//   far lateral) with no return to road centre or forward road → unresponsive. Occlusion neither adds
//   nor clears it: no alert from a LOST frame (T8 review I2). Once pending it persists below 10 km/h and
//   keeps accumulating at any speed; it clears only on an on-road frame or after a KNOWN speed below
//   criticalEndBelowKmh held for criticalEndAfterS (as a Critical ends; unknown speed never clears it;
//   T8 round-1 review R1-I1). Nothing new starts below 10 (or 20) km/h.
// Speed gates: below 20 km/h nothing drains or counts (log only); below 10, or unknown, no alert at all.
import type { DmsConfig, ZoneId, ZoneSpec } from './config';
import type { CalibrationState } from './calibration';
import { createGlanceTracker, type Glance } from './glances';
import type { Sensitivity } from './types';
import { RingBuffer, TimeBuckets } from './windows';

export interface DistractionGates {
  d1: boolean;
  d2: boolean;
  d3: boolean;
}

/**
 * Which rules may run: D1 needs a centre (C-5), the gaze-rules fps floor, and no IMU-absent speed hold
 * (T1r1 R1-m1); D2 also needs `calibrated`/`seeded`/`provisional` and no warm-up (§M5) and no pending resume check
 * (§M3); D3 needs no warm-up and no resume check.
 */
export function distractionGates(s: {
  hasCentre: boolean;
  warmup: boolean;
  calibState: CalibrationState;
  resumeCheck: boolean;
  fpsOk: boolean;
  imuAbsentHold: boolean;
}): DistractionGates {
  const d1 = s.hasCentre && s.fpsOk && !s.imuAbsentHold;
  return {
    d1,
    // `provisional` is a seeded drive that has not passed yet (T8 review m1).
    d2: d1 && !s.warmup && !s.resumeCheck && (s.calibState === 'calibrated' || s.calibState === 'seeded' || s.calibState === 'provisional'),
    d3: d1 && !s.warmup && !s.resumeCheck,
  };
}

export interface AttentionInput {
  tMs: number;
  dtS: number;
  /** the frame's zone; null = occlusion or no direction (freezes) */
  zone: ZoneId | null;
  headYawSpeedDegS: number | null;
  /** the speed the rules use (ContextState.ruleSpeedKmh); null counts as below 10 */
  ruleSpeedKmh: number | null;
  /** the speed is measured now (ContextState.speedKnown): only a known low speed ends a pending D4 */
  speedKnown: boolean;
  /** SEARCH or phone handling: the buffer and the accumulators hold */
  freeze: boolean;
  gates: DistractionGates;
}

export type AttentionEventKind = 'd1_warning' | 'd1_rearmed' | 'd2_warning' | 'd2_reset' | 'd3_phone_pattern' | 'd4_unresponsive' | 'glance_end';

export interface AttentionEvent {
  kind: AttentionEventKind;
  tMs: number;
  zone?: ZoneId;
  glance?: Glance;
}

export interface AttentionOutput {
  bufferFraction: number;
  d2SumS: number;
  glanceActive: boolean;
  events: AttentionEvent[];
}

const EPS = 1e-9;

export function createAttention(cfg: DmsConfig, sensitivity: Sensitivity) {
  const d = cfg.distraction;
  const zones = new Map<ZoneId, ZoneSpec>(cfg.zones.table.map((z) => [z.id, z]));
  const glances = createGlanceTracker(cfg);
  const vats = new TimeBuckets(d.d2.windowS * 1000, d.d2.bucketMs);
  const lapStarts = new RingBuffer<number>(16);

  let f = 1;
  let d1Armed = true;
  let d2Armed = true;
  let d2ResetDone = false;
  let lastD3T = Number.NEGATIVE_INFINITY;
  let lapCountedFor: number | null = null;
  /** unfrozen lap seconds in the current glance (D3 ignores time under SEARCH or handling) */
  let d3Lap = { startT: Number.NaN, s: 0 };
  /** observed off-road seconds since a D1/D2 warning; null when none is pending */
  let d4OffS: number | null = null;
  /** start of the current run of a known speed below criticalEndBelowKmh while D4 is pending */
  let lowKnownSince: number | null = null;
  const grace = new Map<ZoneId, number>();

  function bufferS(speedKmh: number): number {
    const fast = speedKmh >= d.d1.fastFromKmh;
    const base = fast ? d.d1.bufferFastS : d.d1.bufferCityS;
    const scaled = base * d.d1.sensitivity[sensitivity];
    return sensitivity === 'low' ? Math.min(scaled, fast ? d.d1.lowCapFastS : d.d1.lowCapCityS) : scaled;
  }

  return {
    reset() {
      glances.reset();
      vats.reset();
      lapStarts.clear();
      f = 1;
      d1Armed = true;
      d2Armed = true;
      d4OffS = null;
      lowKnownSince = null;
      grace.clear();
    },

    /**
     * Final review m5: the warning D4 would escalate was stopped (a gate close, the camera off): D4's pending
     * state ends with it.
     */
    clearEscalation() {
      d4OffS = null;
      lowKnownSince = null;
    },

    /**
     * Final review m5: a row tick with no frame advances D4's known-low clear, as the alert manager's
     * corroboration advances on it (so a known stop during a camera pause clears both, never one).
     */
    rowTick(tMs: number, speedKnown: boolean, ruleSpeedKmh: number | null) {
      if (d4OffS === null) return;
      const al = cfg.alerts;
      if (speedKnown && ruleSpeedKmh !== null && ruleSpeedKmh < al.criticalEndBelowKmh) {
        lowKnownSince ??= tMs;
        if (tMs - lowKnownSince >= al.criticalEndAfterS * 1000 - EPS) {
          d4OffS = null;
          lowKnownSince = null;
        }
      } else lowKnownSince = null;
    },

    onFrame(x: AttentionInput): AttentionOutput {
      const events: AttentionEvent[] = [];
      const speed = x.ruleSpeedKmh ?? 0;
      const alerting = speed >= d.noAlertBelowKmh;
      const counting = speed >= d.logOnlyBelowKmh;
      const g = glances.onFrame(x.tMs, x.dtS, x.zone, x.headYawSpeedDegS);
      if (g.ended !== null) {
        events.push({ kind: 'glance_end', tMs: x.tMs, zone: g.ended.zone, glance: g.ended });
        grace.clear();
        lapCountedFor = null;
      }
      const spec = x.zone === null ? null : zones.get(x.zone)!;
      const onRoad = spec !== null && spec.class === 'on_road';

      // D1 — the buffer.
      if (!x.freeze && spec !== null) {
        if (!onRoad && g.current !== null) {
          const used = (grace.get(spec.id) ?? 0) + x.dtS;
          grace.set(spec.id, used);
          const graceS = spec.id === 'far_lateral' && g.current.shoulderCheck && spec.shoulderCheckGraceS !== null ? spec.shoulderCheckGraceS : spec.graceS;
          const draining = Math.min(x.dtS, Math.max(0, used - graceS));
          if (counting && x.gates.d1 && draining > 0) f = Math.max(0, f - (spec.weight * draining) / bufferS(speed));
        } else if (onRoad) {
          const refill = Math.min(x.dtS, Math.max(0, g.onRoadRunS - d.d1.refillAfterMs / 1000));
          if (refill > 0) f = Math.min(1, f + refill / bufferS(Math.max(speed, d.logOnlyBelowKmh)));
        }
      }
      if (d1Armed && f <= EPS && alerting && counting && x.gates.d1) {
        d1Armed = false;
        events.push({ kind: 'd1_warning', tMs: x.tMs, zone: g.current?.zone ?? x.zone ?? undefined });
        d4OffS ??= 0;
      } else if (!d1Armed && f >= d.d1.rearmFraction - EPS) {
        d1Armed = true;
        events.push({ kind: 'd1_rearmed', tMs: x.tMs });
      }

      // D2 — VATS with its reset.
      if (!x.freeze && spec !== null) {
        if (onRoad) {
          if (!d2ResetDone && g.onRoadRunS >= d.d2.resetOnRoadS - EPS) {
            vats.reset();
            d2ResetDone = true;
            if (!d2Armed) events.push({ kind: 'd2_reset', tMs: x.tMs });
            d2Armed = true;
          }
        } else {
          d2ResetDone = false;
          const shoulder = spec.id === 'far_lateral' && g.current?.shoulderCheck === true;
          if (spec.class === 'non_driving' && !shoulder && counting && x.gates.d2) vats.add(x.tMs, x.dtS);
        }
      }
      const d2SumS = vats.sum(x.tMs);
      if (d2Armed && d2SumS >= d.d2.warnS - EPS && alerting && counting && x.gates.d2) {
        d2Armed = false;
        events.push({ kind: 'd2_warning', tMs: x.tMs });
        d4OffS ??= 0;
      }

      // D3 — the phone pattern: a glance counts once its lap time reaches 1.0 s.
      // SEARCH and handling hold it, as they hold D1 and D2 (T8 review m2; C-17: M3 owns handling).
      if (g.current !== null && d3Lap.startT !== g.current.startT) d3Lap = { startT: g.current.startT, s: 0 };
      if (!x.freeze && x.zone === 'lap') d3Lap.s += x.dtS;
      if (!x.freeze && g.current !== null && lapCountedFor !== g.current.startT && d3Lap.s >= d.d3.minLapS - EPS && counting && x.gates.d3) {
        lapCountedFor = g.current.startT;
        lapStarts.push(g.current.startT);
        lapStarts.dropWhile((t) => t < g.current!.startT - d.d3.withinS * 1000);
        if (lapStarts.size >= d.d3.minGlances && x.tMs - lastD3T >= d.d3.cooldownS * 1000 && alerting) {
          lastD3T = x.tMs;
          lapStarts.clear();
          events.push({ kind: 'd3_phone_pattern', tMs: x.tMs });
        }
      }

      // D4 — unresponsive after a D1/D2 warning.
      if (d4OffS !== null && !events.some((e) => e.kind === 'd1_warning' || e.kind === 'd2_warning')) {
        const al = cfg.alerts;
        if (x.speedKnown && x.ruleSpeedKmh !== null && x.ruleSpeedKmh < al.criticalEndBelowKmh) lowKnownSince ??= x.tMs;
        else lowKnownSince = null;
        if (onRoad || (lowKnownSince !== null && x.tMs - lowKnownSince >= al.criticalEndAfterS * 1000 - EPS)) {
          d4OffS = null;
          lowKnownSince = null;
        } else if (spec !== null) {
          // Observed off-road only; a handling freeze with a zone still counts (a phone in hand).
          d4OffS += x.dtS;
          if (d4OffS >= d.d4.returnWithinS - EPS) {
            d4OffS = null;
            lowKnownSince = null;
            events.push({ kind: 'd4_unresponsive', tMs: x.tMs });
          }
        }
      }

      return { bufferFraction: f, d2SumS, glanceActive: g.active, events };
    },
  };
}
