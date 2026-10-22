// The speed the driving screen shows (PRODUCT.md "Operating Context", the halo). Display only:
// nothing scores, stops or ends a drive on it; `stopped`, the lockout and every detector read each
// row's raw GPS speed, the most accurate reading the phone gives of the speed at that moment.
//
// L1, the measurement: each GPS fix's Doppler speed, the moment the phone reports it (native's
//   `speed` event, about once a second, saying how old the fix already is), timed at the fix itself.
//   A row's own fix stands in only while no `speed` event has come for `EVENT_STALE_MS` (a native
//   build without the event), timed `ROW_FIX_AGE_MS` before the row. No speed is read from positions
//   (noisier and later than Doppler), and a fix outside the row's GNSS gate (`GNSS_MAX_HACC_M`) or
//   with no speed measures nothing.
// L2, the filter: a two-state Kalman filter (speed and acceleration; the acceleration free to change
//   as white jerk of density `JERK_PSD`) that weighs each fix by its own speed accuracy (`sigmaOf`),
//   so a steady speed reads steady and a poorly rated fix moves it little. A car standing still (a
//   fix under 1 mph), a first fix or one after `GAP_RESET_MS` without any starts it afresh.
// L3, now: the screen carries the estimate on along its acceleration from the fix's own time to the
//   present (`carriedSpeed`: a fix is 0.1 to 0.4 s old when it lands and the next comes a second
//   later), for at most `CARRY_MAX_MS` after the fix, re-read every `SPEED_TICK_MS`; never under 0,
//   and 0 once a slowing car drops under 1 mph. An acceleration inside `ACCEL_DEADBAND_MPS2` is not
//   carried (a cruise holds still between fixes), and none over `ACCEL_MAX_MPS2`.
// S2, 0 mph reads 0: under 1 mph it is 0. Under 3 mph it is 0 while the speed is below its own
//   accuracy rating, while the car is still (aligned and the forward acceleration within
//   `STILL_LON_G` all of the latest row's second), or while it already shows 0 and the IMU does not
//   say the car is pulling away (`LEAVE_ZERO_MPS2`; GPS drift jumps, so its change alone never
//   leaves 0). While it shows 0 nothing is carried.
// S3, a lost fix: past `CARRY_MAX_MS` the screen holds the carried speed flat. A row that finds the
//   last measured fix more than `SPEED_HOLD_MS` old shows 0 when the car is still or already showed
//   0 (a parked phone often stops reporting a speed), and otherwise keeps holding. Before the first
//   fix it is 0. The screen never shows "—" for the speed.
// S4, the clock stepped back (a manual or network time correction): a fix more than
//   `CLOCK_STEP_BACK_MS` older than the filter's time, or than the last event's, starts the filter
//   afresh and becomes the latest event, instead of being ignored as old until the clock catches up
//   (which froze the number). A fix up to that much older is still ignored as out of order.
import type { FeatureRow } from './types';

import { MPS_PER_MPH } from '@/core/detectors/common';

const G_MPS2 = 9.80665;

/** S2: always 0 under this. */
export const ZERO_MPS = 1 * MPS_PER_MPH;
/** S2: never zeroed for accuracy, stillness or hysteresis at or above this. */
export const STOP_DISPLAY_MAX_MPS = 3 * MPS_PER_MPH;
/** S2: a car showing 0 under 3 mph shows its speed only while the IMU reads it accelerating at least this hard. */
export const LEAVE_ZERO_MPS2 = 0.3;
/** S2: still when the aligned forward acceleration stays within ± this all second (g). */
export const STILL_LON_G = 0.02;
/** S3: a row finding the last fix older than this shows 0 for a still car (row clock). */
export const SPEED_HOLD_MS = 3_000;
/** L3: under this the car is cruising and the number is not carried (no wander at a steady speed). */
export const ACCEL_DEADBAND_MPS2 = 0.5;
/** L2/L3: no acceleration beyond this is believed or carried (a hard stop is about 8 m/s²). */
export const ACCEL_MAX_MPS2 = 8;
/** L3: the screen moves the number on this often while it carries it… */
export const SPEED_TICK_MS = 250;
/** …for at most this long after the fix (the next one normally lands about 1.2 s after it). */
export const CARRY_MAX_MS = 1_500;
/** L2: the white-jerk density of the process model, (m/s³)²·s. */
export const JERK_PSD = 1;
/** L2: a fix's speed weighs as this share of its own accuracy rating (phones rate conservatively)… */
export const SPEED_ACC_SCALE = 0.5;
/** …held within these bounds (m/s); a fix with no rating counts as `SIGMA_UNRATED_MPS`. */
export const SIGMA_MIN_MPS = 0.1;
export const SIGMA_MAX_MPS = 3;
export const SIGMA_UNRATED_MPS = 0.3;
/** L2: the acceleration's starting uncertainty, (m/s²)². */
const ACCEL_VAR0 = 4;
/** L2: a fix this long after the last one starts the filter afresh. */
export const GAP_RESET_MS = 3_000;
/** L1: rows stand in for the `speed` event only once none has come for this long (row clock). */
export const EVENT_STALE_MS = 2_500;
/** L1: a row's own fix is taken to be this old at the row (the middle of its second). */
export const ROW_FIX_AGE_MS = 500;
/** L1: the row's GNSS gate (`modules/drive-sense` `GNSS_MAX_HACC_M`), for a `speed` event too. */
export const GNSS_MAX_HACC_M = 50;
/** S4: a fix this much older than the last one (filter or event time) means the clock stepped back. */
export const CLOCK_STEP_BACK_MS = 2_000;

/** One fix's speed, as the `speed` event or a row brings it. */
export interface SpeedFix {
  /** When the fix was taken, epoch ms (the host's clock: arrival less the fix's age). */
  at: number;
  /** Doppler speed, m/s; negative: none. */
  mps: number;
  /** Its accuracy rating, m/s (about one standard deviation); negative: not rated. */
  acc: number;
  /** Horizontal accuracy, m; negative: unknown (measures nothing). */
  hAcc: number;
}

/** What the latest row's IMU says (null before the forward axis is learned). */
interface ImuCue {
  still: boolean;
  pullingAway: boolean;
}

/** The filter: speed and acceleration at `t`, and their covariance. */
interface Kalman {
  t: number;
  v: number;
  a: number;
  pvv: number;
  pva: number;
  paa: number;
}

export type DisplaySpeed = {
  /** The speed to show at `at` (m/s): the estimate, or 0 for S2. */
  mps: number;
  /** The acceleration to carry it on with from `at` (m/s²); 0: not carried. */
  accel: number;
  /** The time `mps` stands for: the last measured fix's (epoch ms), or the row's before any. */
  at: number;
  /** It shows 0 for S2 (the hysteresis reads it). */
  zero: boolean;
  /** The filter, null before the first measured fix. */
  kf: Kalman | null;
  /** The latest measured fix's speed accuracy (S2), negative when not rated. */
  acc: number;
  /** The latest `speed` event's fix time, null before any (L1: rows stand in without one). */
  eventAt: number | null;
  imu: ImuCue | null;
};

/** A fix's standard deviation for the filter (m/s). */
export function sigmaOf(acc: number): number {
  if (!(acc >= 0)) return SIGMA_UNRATED_MPS;
  return Math.min(SIGMA_MAX_MPS, Math.max(SIGMA_MIN_MPS, acc * SPEED_ACC_SCALE));
}

const clampAccel = (a: number): number => Math.min(ACCEL_MAX_MPS2, Math.max(-ACCEL_MAX_MPS2, a));

function fresh(t: number, v: number, r: number): Kalman {
  return { t, v, a: 0, pvv: r, pva: 0, paa: ACCEL_VAR0 };
}

/** One Kalman step: predict to `t`, then take the speed `z` with variance `r`. */
export function kalmanStep(kf: Kalman | null, t: number, z: number, r: number): Kalman {
  if (kf === null || t - kf.t > GAP_RESET_MS || z < ZERO_MPS) return fresh(t, z, r);
  const dt = (t - kf.t) / 1000;
  const q = JERK_PSD;
  // Predict: v' = v + a·dt, a' = a; P' = F·P·Fᵀ + Q (white jerk).
  const v = kf.v + kf.a * dt;
  const pvv = kf.pvv + 2 * dt * kf.pva + dt * dt * kf.paa + (q * dt * dt * dt) / 3;
  const pva = kf.pva + dt * kf.paa + (q * dt * dt) / 2;
  const paa = kf.paa + q * dt;
  // Update with the measured speed.
  const s = pvv + r;
  const kv = pvv / s;
  const ka = pva / s;
  const y = z - v;
  return {
    t,
    v: Math.max(0, v + kv * y),
    a: clampAccel(kf.a + ka * y),
    pvv: (1 - kv) * pvv,
    pva: (1 - kv) * pva,
    paa: paa - ka * pva,
  };
}

/** This second's mean forward acceleration from the IMU (m/s²), or null before the axis is learned. */
function imuAccel(row: FeatureRow): number | null {
  if (row.aLonMax === 0 && row.aLonMin === 0) return null;
  return ((row.aLonMax + row.aLonMin) / 2) * G_MPS2;
}

/** Still: the axis is learned and the forward acceleration stayed near 0 all second. */
function still(row: FeatureRow): boolean {
  if (row.aLonMax === 0 && row.aLonMin === 0) return false;
  return Math.max(Math.abs(row.aLonMax), Math.abs(row.aLonMin)) < STILL_LON_G;
}

function cueOf(row: FeatureRow): ImuCue | null {
  const a = imuAccel(row);
  if (a === null) return null;
  return { still: still(row), pullingAway: a >= LEAVE_ZERO_MPS2 };
}

const EMPTY = (at: number): DisplaySpeed => ({ mps: 0, accel: 0, at, zero: true, kf: null, acc: -1, eventAt: null, imu: null });

/** S2 over the filter's estimate: what to show at `kf.t`. */
function shown(prev: DisplaySpeed, kf: Kalman, acc: number, eventAt: number | null, imu: ImuCue | null): DisplaySpeed {
  const v = kf.v;
  const rated = acc >= 0 && v < acc;
  const pullingAway = imu?.pullingAway ?? false;
  const zero = v < ZERO_MPS || (v < STOP_DISPLAY_MAX_MPS && (rated || (imu?.still ?? false) || (prev.zero && !pullingAway)));
  const accel = zero || Math.abs(kf.a) < ACCEL_DEADBAND_MPS2 ? 0 : kf.a;
  return { mps: zero ? 0 : v, accel, at: kf.t, zero, kf, acc, eventAt, imu };
}

/** Whether a fix can measure the speed (L1). */
const measures = (f: SpeedFix): boolean => f.mps >= 0 && f.hAcc >= 0 && f.hAcc <= GNSS_MAX_HACC_M && Number.isFinite(f.at);

/** S4: `at` lies more than `CLOCK_STEP_BACK_MS` before `than`: the clock stepped back between them. */
const steppedBack = (at: number, than: number | null): boolean => than !== null && at < than - CLOCK_STEP_BACK_MS;

function measure(prev: DisplaySpeed, f: SpeedFix, eventAt: number | null): DisplaySpeed {
  // S4: a filter from before a backward clock step is dropped, so this fix starts it afresh.
  const kf0 = prev.kf !== null && steppedBack(f.at, prev.kf.t) ? null : prev.kf;
  if (kf0 !== null && f.at <= kf0.t) return eventAt === prev.eventAt ? prev : { ...prev, eventAt };
  const sigma = sigmaOf(f.acc);
  const kf = kalmanStep(kf0, f.at, f.mps, sigma * sigma);
  return shown(prev, kf, f.acc, eventAt, prev.imu);
}

/**
 * A `speed` event (L1): the fix measures the speed at once. `prev` null: before anything this drive.
 * A fix that measures nothing changes nothing but the time the last event came.
 */
export function displayFix(prev: DisplaySpeed | null, f: SpeedFix): DisplaySpeed {
  const base = prev ?? EMPTY(f.at);
  // S4: after a backward clock step the newest event is this one, not the one from the old clock.
  const eventAt = base.eventAt === null || steppedBack(f.at, base.eventAt) ? f.at : Math.max(base.eventAt, f.at);
  if (!measures(f)) return eventAt === base.eventAt ? base : { ...base, eventAt };
  return measure(base, f, eventAt);
}

/**
 * A row: the IMU cue for S2, its own fix while no `speed` event is coming (L1), and S3. `known`
 * is the row's known GPS speed (`knownSpeed`), null when it lost its fix.
 */
export function displayRow(prev: DisplaySpeed | null, row: FeatureRow, known: number | null): DisplaySpeed {
  const imu = cueOf(row);
  let d: DisplaySpeed = { ...(prev ?? EMPTY(row.ts)), imu };
  const eventsStale = d.eventAt === null || row.ts - d.eventAt > EVENT_STALE_MS;
  if (eventsStale && known !== null) {
    d = measure(d, { at: row.ts - ROW_FIX_AGE_MS, mps: known, acc: row.speedAcc, hAcc: row.hAcc }, d.eventAt);
  }
  if (d.kf === null) return { ...d, mps: 0, accel: 0, zero: true };
  if (row.ts - d.kf.t > SPEED_HOLD_MS) {
    // S3: a still car, or one already at 0, reads 0; otherwise the screen holds the last speed.
    if (d.zero || still(row)) return { ...d, mps: 0, accel: 0, zero: true };
    return d;
  }
  // S2 again with this row's IMU (a car pulling away, or one gone still, since the fix).
  return shown(d, d.kf, d.acc, d.eventAt, imu);
}

/**
 * The speed `elapsedMs` after the time it stands for (m/s), for the screen: carried along the
 * acceleration for at most `CARRY_MAX_MS`, never below 0, and 0 once a slowing car drops under
 * 1 mph (S2).
 */
export function carriedSpeed(mps: number, accel: number, elapsedMs: number): number {
  if (mps <= 0 || accel === 0) return mps;
  const v = mps + (accel * Math.min(Math.max(0, elapsedMs), CARRY_MAX_MS)) / 1000;
  return v < ZERO_MPS ? 0 : v;
}

/** Whole units on the screen move only once the speed is this far past the half (no flicker at x.5). */
export const ROUND_HYSTERESIS = 0.3;

/** The whole number to show for `value` (display units), given the one shown now (null: none yet). */
export function wholeSpeed(prev: number | null, value: number): number {
  const r = Math.round(value);
  if (prev === null || r === prev) return r;
  return Math.abs(value - prev) < 0.5 + ROUND_HYSTERESIS ? prev : r;
}
