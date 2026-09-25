// Vehicle context from the 1 Hz drive-sense rows (plan §M1 units, §M3 straight flag, C-19, rev1 I5/I6).
// The engine never imports M1's types (purity); `FeatureRowLike` is the subset it reads, and the host
// pins it assignable from `FeatureRow` (Task 14). Rows are applied at the latest frame time `tMs`.
import { courseRateDegS } from './angles';
import type { DmsConfig } from './config';
import type { RowMotion, VehicleContext } from './types';

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
  /**
   * The shared motion evidence for this row (Task C1; `src/core/engine/motionEvidence.ts`), computed once
   * per row by the host and carried here as given. Read by the speed states from Task C2 on.
   */
  motion?: RowMotion;
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

/**
 * The engine's speed states (Task C2; rev4 §2.1.3, rev3 §2.1.3):
 * - `stopped`: a GNSS stop (a known speed below 10 km/h) or the evidence's latched sensor stop. The rule speed
 *   is the known speed, or 0. The sleep family is armed; everything else is frozen or silent.
 * - `moving_known`: a known speed of 10 km/h or more.
 * - `moving_held`: no fix, no stop, not ambiguous: the last known speed held (≤ tunnelHoldMs), then null.
 * - `ambiguous`: no fix, the evidence's ambiguous stillness (10 s of quiet rows, no stop): the held speed, with
 *   D1–D3 frozen (E1 ruled, U-7).
 * - `moving_after_stop`: no fix since a stop: the evidence's `vLowKmh` (a lower bound from 0), or null. Never
 *   the pre-stop speed (E2 fixed).
 * - `unknown`: evidence was seen in this drive but none has come for more than rowStaleMs (the C1 round-1
 *   carry): neither stopped nor moving; the rule speed is null.
 * A drive with no evidence at all (older callers, the replay's plain drives) keeps the tunnel rules below, and a
 * known speed below 10 is `stopped`.
 */
export type SpeedState = 'stopped' | 'moving_known' | 'moving_held' | 'ambiguous' | 'moving_after_stop' | 'unknown';

/** The per-frame view: the context (stale speed nulled) and the speed the rules use under the tunnel rules. */
export interface ContextState {
  ctx: VehicleContext | null;
  /**
   * The speed is measured now (not held or inferred). A Critical ends, and the capture pauses, only on
   * a KNOWN speed (rev1 I6; T8 review m4, carried to Tasks 11 and 13).
   */
  speedKnown: boolean;
  /** known speed, or the held last known speed (rev1 I6), or 0 after the still hold; null = none known yet */
  ruleSpeedKmh: number | null;
  /** the rule speed is a held value */
  speedHeld: boolean;
  /** held with the IMU absent: only F1–F3 and D4 may use it; D1–D3 stay off (T1r1 R1-m1) */
  imuAbsentHold: boolean;
  /** Task C2: the speed state (see SpeedState) */
  speedState: SpeedState;
  /** Task C2: the engine's STOPPED state (the silence, the clear and the stop-time marking read it) */
  stopped: boolean;
  /** Task C2: AMBIGUOUS_STILL: D1–D3 are frozen while the held speed stays (U-7) */
  distractionFrozen: boolean;
}

export function createContextTracker(cfg: Pick<DmsConfig, 'context' | 'calibration' | 'alerts'>) {
  const c = cfg.calibration;
  /** a known speed below this is a GNSS stop (motionEvidence's STOP_KMH; the Critical end's threshold) */
  const stopKmh = cfg.alerts.criticalEndBelowKmh;
  /** Task C2: the drive has seen motion evidence; the last evidence and the frame time of its row */
  let hadMotion = false;
  let lastMotion: RowMotion | null = null;
  let lastMotionT = Number.NEGATIVE_INFINITY;
  /** Task C2: no fix since a stop (GNSS or sensor): the held speed is vLowKmh, never the pre-stop speed (E2) */
  let afterStop = false;
  let prev: FeatureRowLike | null = null;
  let last: VehicleContext | null = null;
  let lastRowT = 0;
  /** the last straight-candidate rows (valid fix, course rate known) */
  const window: { ok: boolean }[] = [];
  let lastKnown: { speed: number; t: number } | null = null;
  /** the first row of the current continuous run of still rows (T8 review I1); any moving row resets it */
  let stillSince: number | null = null;

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
      if (ctx.speedKmh !== null) lastKnown = { speed: ctx.speedKmh, t: tMs };
      stillSince = ex.imuMoving ? null : (stillSince ?? tMs);
      if (ex.motion !== undefined) {
        hadMotion = true;
        lastMotion = ex.motion;
        lastMotionT = tMs;
      }
      if (ctx.speedKmh !== null) afterStop = ctx.speedKmh < stopKmh;
      else if (ex.motion !== undefined && ex.motion.stop !== null) afterStop = true;
      prev = r;
      last = ctx;
      lastRowT = tMs;
      return ctx;
    },

    /**
     * The tunnel rules (rev1 I6, as fixed by T8 review I1 and m3):
     * - moving (the current row run is not still): the last known speed is held while
     *   tMs − lastKnown ≤ tunnelHoldMs, then null (below 10);
     * - still (a continuous run of still rows since `stillSince`): held while tMs − stillSince ≤
     *   unknownStillHoldMs, then 0;
     * - no rows arriving (stale): no motion evidence at all, so the still path from the last row.
     */
    at(tMs: number): ContextState {
      const none = { speedKnown: false, speedHeld: false, imuAbsentHold: false, stopped: false, distractionFrozen: false };
      if (last === null) return { ctx: null, ruleSpeedKmh: null, ...none, speedState: 'unknown' };
      const stale = tMs - lastRowT > cfg.context.rowStaleMs;
      const ctx: VehicleContext = stale ? { ...last, speedKmh: null, straight: null, courseRateDegS: null, turnSign: 0 } : last;
      if (ctx.speedKmh !== null) {
        const stopped = ctx.speedKmh < stopKmh;
        return { ctx, ruleSpeedKmh: ctx.speedKmh, ...none, speedKnown: true, stopped, speedState: stopped ? 'stopped' : 'moving_known' };
      }
      const heldSpeed = lastKnown !== null && tMs - lastKnown.t <= cfg.context.tunnelHoldMs ? lastKnown.speed : null;
      const held = (speedState: SpeedState, distractionFrozen: boolean): ContextState =>
        heldSpeed === null
          ? { ctx, ruleSpeedKmh: null, ...none, speedState, distractionFrozen }
          : { ctx, ruleSpeedKmh: heldSpeed, ...none, speedHeld: true, imuAbsentHold: !last!.imuPresent, speedState, distractionFrozen };
      if (hadMotion) {
        // Task C2: the evidence decides. Absent evidence (a ts mismatch, a missing source) holds the last one for
        // at most rowStaleMs, then the state is unknown: never moving, never stopped (the C1 round-1 carry).
        const m = tMs - lastMotionT <= cfg.context.rowStaleMs ? lastMotion : null;
        if (m === null) return { ctx, ruleSpeedKmh: null, ...none, speedState: 'unknown' };
        if (m.stop !== null) return { ctx, ruleSpeedKmh: 0, ...none, stopped: true, speedState: 'stopped' };
        if (afterStop) return { ctx, ruleSpeedKmh: m.vLowKmh, ...none, speedState: 'moving_after_stop' };
        if (m.ambiguousStill) return held('ambiguous', true);
        return held('moving_held', false);
      }
      // No evidence in this drive: the tunnel rules (rev1 I6; T8 review I1, m3).
      if (lastKnown === null) return { ctx, ruleSpeedKmh: null, ...none, speedState: 'unknown' };
      const legacyHeld = { ctx, ruleSpeedKmh: lastKnown.speed, ...none, speedHeld: true, imuAbsentHold: !last.imuPresent, speedState: 'moving_held' as const };
      const stillRef = stale ? (stillSince ?? lastRowT) : stillSince;
      if (stillRef === null) return tMs - lastKnown.t <= cfg.context.tunnelHoldMs ? legacyHeld : { ctx, ruleSpeedKmh: null, ...none, speedState: 'unknown' };
      return tMs - stillRef <= cfg.context.unknownStillHoldMs ? legacyHeld : { ctx, ruleSpeedKmh: 0, ...none, speedState: 'ambiguous' };
    },
  };
}
