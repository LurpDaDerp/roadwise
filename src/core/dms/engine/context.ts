// Vehicle context from the 1 Hz drive-sense rows (plan §M1 units, §M3 straight flag, C-19, rev1 I5/I6).
// The engine never imports M1's types (purity); `FeatureRowLike` is the subset it reads, and the host
// pins it assignable from `FeatureRow` (Task 14). Rows are applied at the latest frame time `tMs`.
import { courseRateDegS } from './angles';
import type { DmsConfig } from './config';
import type { VehicleContext } from './types';

const DEG = 180 / Math.PI;

/** The drive-sense row fields the engine reads (native units: m/s, rad/s, degrees). */
export interface FeatureRowLike {
  /** epoch ms */
  ts: number;
  /** m/s; −1 unknown */
  speed: number;
  /** degrees clockwise from north */
  course: number;
  gnssValid: boolean;
  aLonMax: number;
  aLonMin: number;
  aLatMax: number;
  aLatMin: number;
  /** unsigned per-second gyro peak, rad/s */
  yawRateMax: number;
  jerkMax: number;
  gravityStability: number;
  orientationDelta: number;
  handlingScore: number;
}

/** What the host adds to each row: IMU motion by the drive engine's own `stillWithoutFix` (rev2 R1-m1). */
export interface RowExtras {
  imuMoving: boolean;
  localMinutes: number | null;
  tripElapsedS: number;
}

/** C-19: all nine IMU fields 0 means the IMU is absent. */
export function imuPresent(r: FeatureRowLike): boolean {
  return [r.aLonMax, r.aLonMin, r.aLatMax, r.aLatMin, r.yawRateMax, r.jerkMax, r.gravityStability, r.orientationDelta, r.handlingScore].some((v) => v !== 0);
}

const validFix = (r: FeatureRowLike, cfg: Pick<DmsConfig, 'context'>) => r.gnssValid && r.speed >= cfg.context.courseMinSpeedMs;

/**
 * One row's context. The course rate is the wrapped Δcourse/Δt against `prev` (both valid fixes at
 * ≥ courseMinSpeedMs); the turn sign needs |rate| > turnSignMinDegS. `straight` here is only "not known
 * false"; the tracker sets it from 3 consecutive rows.
 */
export function contextFromRow(r: FeatureRowLike, prev: FeatureRowLike | null, tMs: number, ex: RowExtras, cfg: Pick<DmsConfig, 'context'>): VehicleContext {
  const imu = imuPresent(r);
  const speedKmh = r.gnssValid && r.speed >= 0 ? r.speed * 3.6 : null;
  const rate = prev !== null && validFix(r, cfg) && validFix(prev, cfg) ? courseRateDegS(prev.course, prev.ts, r.course, r.ts) : null;
  const turnSign: -1 | 0 | 1 = rate !== null && Math.abs(rate) > cfg.context.turnSignMinDegS ? (rate > 0 ? 1 : -1) : 0;
  return {
    tMs,
    speedKmh,
    yawRateDegS: imu ? r.yawRateMax * DEG : null,
    courseRateDegS: rate,
    turnSign,
    straight: r.gnssValid ? false : null,
    handling: r.handlingScore >= cfg.context.handlingMinScore,
    imuPresent: imu,
    imuMoving: ex.imuMoving,
    localMinutes: ex.localMinutes,
    tripElapsedS: ex.tripElapsedS,
  };
}

/** The per-frame view: the context (stale speed nulled) and the speed the rules use under the tunnel rules. */
export interface ContextState {
  ctx: VehicleContext | null;
  /** known speed, or the held last known speed (rev1 I6), or 0 after the still hold; null = none known yet */
  ruleSpeedKmh: number | null;
  /** the rule speed is a held value */
  speedHeld: boolean;
  /** held with the IMU absent: only F1–F3 and D4 may use it; D1–D3 stay off (T1r1 R1-m1) */
  imuAbsentHold: boolean;
}

export function createContextTracker(cfg: Pick<DmsConfig, 'context' | 'calibration'>) {
  const c = cfg.calibration;
  let prev: FeatureRowLike | null = null;
  let last: VehicleContext | null = null;
  let lastRowT = 0;
  /** the last straight-candidate rows (valid fix, course rate known) */
  const window: { ok: boolean }[] = [];
  let lastKnown: { speed: number; t: number } | null = null;
  let unknownSince: number | null = null;

  return {
    onRow(r: FeatureRowLike, tMs: number, ex: RowExtras): VehicleContext {
      const ctx = contextFromRow(r, prev, tMs, ex, cfg);
      // The straight flag (§M3): |course rate| < 2°/s on 3 consecutive valid rows at ≥ 30 km/h, and no
      // gyro peak above the veto on any of them. GNSS invalid → unknown (null); nothing is admitted.
      if (!r.gnssValid) {
        window.length = 0;
      } else {
        const ok =
          ctx.courseRateDegS !== null &&
          Math.abs(ctx.courseRateDegS) < c.straightCourseRateDegS &&
          ctx.speedKmh !== null &&
          ctx.speedKmh >= c.straightMinSpeedKmh &&
          !(ctx.yawRateDegS !== null && ctx.yawRateDegS > c.gyroVetoDegS);
        window.push({ ok });
        if (window.length > c.straightRows) window.shift();
        ctx.straight = window.length === c.straightRows && window.every((w) => w.ok);
      }
      if (ctx.speedKmh !== null) {
        lastKnown = { speed: ctx.speedKmh, t: tMs };
        unknownSince = null;
      } else if (unknownSince === null) {
        unknownSince = tMs;
      }
      prev = r;
      last = ctx;
      lastRowT = tMs;
      return ctx;
    },

    at(tMs: number): ContextState {
      if (last === null) return { ctx: null, ruleSpeedKmh: null, speedHeld: false, imuAbsentHold: false };
      const stale = tMs - lastRowT > cfg.context.rowStaleMs;
      const ctx: VehicleContext = stale ? { ...last, speedKmh: null, straight: null, courseRateDegS: null, turnSign: 0 } : last;
      if (ctx.speedKmh !== null) return { ctx, ruleSpeedKmh: ctx.speedKmh, speedHeld: false, imuAbsentHold: false };
      if (lastKnown === null) return { ctx, ruleSpeedKmh: null, speedHeld: false, imuAbsentHold: false };
      const since = unknownSince ?? lastRowT;
      if (last.imuMoving && tMs - lastKnown.t <= cfg.context.tunnelHoldMs) {
        return { ctx, ruleSpeedKmh: lastKnown.speed, speedHeld: true, imuAbsentHold: !last.imuPresent };
      }
      if (!last.imuMoving && tMs - since <= cfg.context.unknownStillHoldMs) {
        return { ctx, ruleSpeedKmh: lastKnown.speed, speedHeld: true, imuAbsentHold: !last.imuPresent };
      }
      // Still after the hold: the car counts as below 10 km/h. Moving past the tunnel hold: unknown.
      return { ctx, ruleSpeedKmh: last.imuMoving ? null : 0, speedHeld: false, imuAbsentHold: false };
    },
  };
}
