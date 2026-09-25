// The shared motion evidence (DMS calibration and stops, Task C1; calib-parked design rev4 §2.1.2,
// rev2 §2.1.2 A–F, rev5 §4). One pure, stateful computation per 1 Hz row, made once by the drive host
// and read by M3's auto-ends (T14) and by the DMS (policy and engine, T2/T3). Nothing here allocates
// per row beyond the evidence object itself; every window is a handful of scalars.
//
// - A GNSS stop: a fresh known speed below STOP_KMH on the row.
// - A sensor stop (no fix): proven only from braking. The speed estimate v̂ integrates aLonMean from the
//   last known speed, but it may FALL only on rows of a braking run (≥ 2 consecutive rows at or below
//   −BRAKE_EVIDENCE_G beyond the measured bias b̂, with a peak at or below −BRAKE_PEAK_G); every other
//   row can only raise it. The uncertainty u grows with time from the fix (U0 + the measured bias bound
//   × T), the horizon is INFERRED_MAX_HORIZON_S, and v̂ + u must be ≤ STOP_KMH on the current row with
//   this row and the previous one quiet. Trust in the accelerometer is earned per alignment epoch: a
//   bias measured on GNSS cruise rows, small enough, and a passed sign check on a GNSS brake. Once
//   entered the stop is latched until a fix, one strong or two weak moving rows, a row gap or an
//   alignment reset. A handling row is never motion.
// - Deep still (engine off, no fix): off by default until device data (U-4).
// - Ambiguous stillness: no fix, AMBIGUOUS_HOLD_S of continuous quiet rows, and no stop evidence.
// - vLowKmh: a lower bound on the speed after a sensor stop ends by motion (from 0, robust to an
//   unmeasured bias of up to RESIDUAL_MAX_G).
// - The mount reference: the median gravity of the drive's first MOUNT_REF_ROWS mounted, handling-free
//   rows; `mountMatch`, `mountLostS` and `mountQuiet` against it.
// Rows without the motion fields (older builds) are unaligned with no accRms or gravity: they can never
// give a sensor stop, deep still or a mount match.
import type { FeatureRow } from './types';

/** 9.80665 m/s² × 3.6: km/h gained per g held for one second. */
export const KMH_PER_G_S = 9.80665 * 3.6;

export const MOTION_CONSTANTS = {
  /** a known speed below this is a stop; the sensor stop proves exactly this bound (R1-4a) */
  STOP_KMH: 10,
  /** the measured-bias bound for trust, g */
  BIAS_G: 0.02,
  BIAS_MARGIN_G: 0.005,
  /** a braking row: aLonMean − b̂ at or below −this, g */
  BRAKE_EVIDENCE_G: 0.06,
  /** a braking run needs a row at or below −this (unambiguous braking, above any residual), g */
  BRAKE_PEAK_G: 0.1,
  /** the largest unmeasured residual the gravity filter documents (Android post-brake tilt), g */
  RESIDUAL_MAX_G: 0.05,
  /** quiet: |aLonMean − b̂| at most this, g (R1-2b) */
  QUIET_MEAN_G: 0.01,
  QUIET_EXTREME_G: 0.05,
  QUIET_YAW_RADS: 0.02,
  /** an unaligned row's stillness: the drive engine's own bounds (machine.ts stillWithoutFix) */
  STILL_GRAVITY_MIN: 0.95,
  STILL_IMU_MAX: 0.05,
  INFERRED_MAX_HORIZON_S: 60,
  /** U0 = max(U0_MIN_KMH, U0_PER_SPEEDACC × speedAcc m/s) */
  U0_MIN_KMH: 2,
  U0_PER_SPEEDACC: 7.2,
  /** cruise rows for the bias: aligned, ≥ this known speed, |Δv| < CRUISE_MAX_DV_KMH both sides, |course rate| < 2°/s */
  CRUISE_MIN_KMH: 20,
  CRUISE_MAX_DV_KMH: 1,
  CRUISE_MAX_COURSE_DEGS: 2,
  BIAS_MIN_ROWS: 30,
  /** the sign check: a GNSS drop of at least this within SIGN_WINDOW_ROWS rows */
  SIGN_BRAKE_DV_KMH: 12,
  SIGN_WINDOW_ROWS: 5,
  SIGN_TOLERANCE: 0.4,
  /** a strong vehicle row: aligned aLonMean − b̂ at or above this, g */
  STRONG_ALON_G: 0.08,
  /** a row gap, judged by row.ts (M-4) */
  ROW_GAP_MS: 1500,
  AMBIGUOUS_HOLD_S: 10,
  V_LOW_VALID_S: 120,
  DEEP_STILL_ENABLED: false,
  DEEP_STILL_G: 0.02,
  DEEP_STILL_HOLD_S: 30,
  DEEP_STILL_YAW_RADS: 0.01,
  DEEP_STILL_GRAVITY_MIN: 0.99,
  MOUNT_REF_ROWS: 60,
  MOUNT_MATCH_RAD: 0.2,
  MOUNT_LOST_RAD: 0.35,
  MOUNT_QUIET_G: 0.08,
};
export type MotionConstants = typeof MOTION_CONSTANTS;

/** The constants' own ordering rules (an empty list when they are sound). */
export function validateMotionConstants(c: MotionConstants = MOTION_CONSTANTS): string[] {
  const bad: string[] = [];
  if (!(c.STOP_KMH > 0)) bad.push('STOP_KMH: must be > 0');
  if (!(c.BIAS_G >= 0 && c.BIAS_MARGIN_G >= 0)) bad.push('BIAS_G, BIAS_MARGIN_G: must be ≥ 0');
  if (!(c.BIAS_G + 0.03 <= c.BRAKE_EVIDENCE_G + 1e-12)) bad.push('BRAKE_EVIDENCE_G: must be ≥ BIAS_G + 0.03');
  if (!(c.BRAKE_EVIDENCE_G > c.RESIDUAL_MAX_G)) bad.push('BRAKE_EVIDENCE_G: must exceed RESIDUAL_MAX_G (the documented residual)');
  if (!(c.RESIDUAL_MAX_G >= 0.047)) bad.push('RESIDUAL_MAX_G: must cover the documented 0.047 g residual');
  if (!(c.BRAKE_PEAK_G >= c.BRAKE_EVIDENCE_G)) bad.push('BRAKE_PEAK_G: must be ≥ BRAKE_EVIDENCE_G');
  if (!(c.QUIET_MEAN_G < c.BIAS_G)) bad.push('QUIET_MEAN_G: must be < BIAS_G');
  if (!(KMH_PER_G_S * (c.BIAS_G + c.BIAS_MARGIN_G) * c.INFERRED_MAX_HORIZON_S + c.U0_MIN_KMH > c.STOP_KMH)) {
    bad.push('INFERRED_MAX_HORIZON_S: beyond it the proof must be impossible anyway');
  }
  if (!(c.STRONG_ALON_G > c.QUIET_MEAN_G)) bad.push('STRONG_ALON_G: must exceed QUIET_MEAN_G');
  if (!(c.ROW_GAP_MS > 1000)) bad.push('ROW_GAP_MS: must exceed the 1 s row period');
  if (!(c.BIAS_MIN_ROWS >= 10)) bad.push('BIAS_MIN_ROWS: must be ≥ 10');
  if (!(c.MOUNT_MATCH_RAD < c.MOUNT_LOST_RAD)) bad.push('MOUNT_MATCH_RAD: must be < MOUNT_LOST_RAD');
  if (!(c.MOUNT_QUIET_G > 0)) bad.push('MOUNT_QUIET_G: must be > 0');
  if (!(c.DEEP_STILL_G > 0 && c.DEEP_STILL_HOLD_S >= 20)) bad.push('DEEP_STILL: G > 0 and a hold ≥ 20 s');
  if (!(c.V_LOW_VALID_S <= 3 * c.INFERRED_MAX_HORIZON_S)) bad.push('V_LOW_VALID_S: must be ≤ 3 × the horizon');
  return bad;
}

export interface MotionEvidence {
  /** the row shows a stop: a GNSS speed below STOP_KMH, or a latched sensor (or deep-still) stop */
  stop: 'gnss' | 'sensor' | 'deep' | null;
  /** moving evidence on this row; a handling row is never moving */
  moving: 'strong' | 'weak' | null;
  /** the row is quiet (condition 7 when aligned, the stillness bounds otherwise) */
  quiet: boolean;
  /** aligned aLonMean − b̂ ≥ STRONG_ALON_G without handling: the car itself accelerating */
  vehicleMotion: boolean;
  /** no fix, AMBIGUOUS_HOLD_S of continuous quiet rows, and no stop */
  ambiguousStill: boolean;
  /** continuous quiet no-fix seconds */
  quietNoFixS: number;
  /** a lower bound on the speed after a sensor stop ended by motion, km/h; null when unknown */
  vLowKmh: number | null;
  /** the accelerometer is trusted in this alignment epoch */
  trust: boolean;
  /** the bias measured on cruise rows in this epoch; null before any */
  bias: { bHat: number; sigma: number; n: number } | null;
  /** the gravity within MOUNT_MATCH_RAD of the mount reference with no handling; null with no reference or no gravity */
  mountMatch: boolean | null;
  mountAngleRad: number | null;
  /** continuous seconds the gravity has been beyond MOUNT_LOST_RAD from the reference */
  mountLostS: number;
  /** accRms below MOUNT_QUIET_G (a mount is quieter than a pocket; rev5 R4-m2); null without accRms */
  mountQuiet: boolean | null;
  /** this row followed a row gap (row.ts, M-4) */
  gap: boolean;
}

type Vec = [number, number, number];

const kmh = (row: FeatureRow): number | null => (row.gnssValid && row.speed >= 0 ? row.speed * 3.6 : null);
const aligned = (row: FeatureRow): boolean => row.frameAligned === true;
const aMean = (row: FeatureRow): number => row.aLonMean ?? 0;
const gravityOf = (row: FeatureRow): Vec | null =>
  typeof row.gravX === 'number' && typeof row.gravY === 'number' && typeof row.gravZ === 'number' ? [row.gravX, row.gravY, row.gravZ] : null;

function wrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function normalize(v: Vec): Vec | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

function angle(a: Vec, b: Vec): number {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

export interface MotionEvidenceSource {
  /** Evidence for this row. `mounted`: the drive's mode is mounted (the mount reference is built only then). */
  onRow(row: FeatureRow, opts?: { mounted?: boolean }): MotionEvidence;
  /** Re-take the mount reference from the next MOUNT_REF_ROWS rows (a committed translation step). */
  resetMountReference(): void;
  /** Forget everything (a new trip). */
  reset(): void;
}

export function createMotionEvidence(c: MotionConstants = MOTION_CONSTANTS): MotionEvidenceSource {
  // ——— rows ———
  let prevTs: number | null = null;
  let prevQuiet = false;
  let last: MotionEvidence | null = null;

  // ——— the alignment epoch: bias and trust ———
  let inEpoch = false;
  let bN = 0;
  let bMean = 0;
  let bM2 = 0;
  let signPass = 0;
  let signFail = 0;
  let signCooldown = 0;
  /** the last contiguous, aligned rows with a known speed in this epoch (for the sign check), oldest first */
  let signWin: { kmh: number; a: number }[] = [];
  /** the last 2 rows for the cruise test of the middle one: [prevprev, prev] */
  let cruiseWin: FeatureRow[] = [];

  // ——— since the last known speed ———
  let fix: { ts: number; kmh: number; speedAcc: number } | null = null;
  let sinceFixOk = false;
  /** the current run of braking rows: its length, peak, the rows' Σδ not yet counted, and whether proven */
  let brakeRun = 0;
  let brakeRunPeak = 0;
  let brakeRunPending = 0;
  let brakeRunProven = false;
  let brakingEpisode = false;
  let sumDelta = 0;

  // ——— the latch, deep still, ambiguous, vLow ———
  let latched: 'sensor' | 'deep' | null = null;
  let weakRun = 0;
  let deepS = 0;
  let quietNoFixS = 0;
  let vLow: { sum: number; t: number } | null = null;

  // ——— the mount ———
  let refRows: Vec[] = [];
  let mountRef: Vec | null = null;
  let mountLostS = 0;

  function bHat(): number {
    return bN > 0 ? bMean : 0;
  }
  function sigma(): number {
    return bN > 1 ? Math.sqrt(bM2 / (bN - 1)) : 0;
  }
  /** |b̂| + 3σ/√n + margin: the per-second bias allowance, g */
  function k(): number {
    return Math.abs(bHat()) + (bN > 0 ? (3 * sigma()) / Math.sqrt(bN) : 0) + c.BIAS_MARGIN_G;
  }
  function trusted(): boolean {
    return inEpoch && bN >= c.BIAS_MIN_ROWS && k() <= c.BIAS_G && signPass >= 1 && signFail === 0;
  }

  function endEpoch(): void {
    inEpoch = false;
    bN = 0;
    bMean = 0;
    bM2 = 0;
    signPass = 0;
    signFail = 0;
    signCooldown = 0;
    signWin = [];
    cruiseWin = [];
  }

  function resetSinceFix(): void {
    fix = null;
    sinceFixOk = false;
    brakeRun = 0;
    brakeRunPeak = 0;
    brakeRunPending = 0;
    brakeRunProven = false;
    brakingEpisode = false;
    sumDelta = 0;
  }

  function reset(): void {
    prevTs = null;
    prevQuiet = false;
    last = null;
    endEpoch();
    resetSinceFix();
    latched = null;
    weakRun = 0;
    deepS = 0;
    quietNoFixS = 0;
    vLow = null;
    refRows = [];
    mountRef = null;
    mountLostS = 0;
  }

  function isQuiet(row: FeatureRow): boolean {
    if (row.handlingScore !== 0) return false;
    if (aligned(row)) {
      return (
        Math.abs(aMean(row) - bHat()) <= c.QUIET_MEAN_G &&
        row.aLonMax <= c.QUIET_EXTREME_G &&
        row.aLonMin >= -c.QUIET_EXTREME_G &&
        row.yawRateMax <= c.QUIET_YAW_RADS
      );
    }
    return (
      row.gravityStability >= c.STILL_GRAVITY_MIN &&
      Math.abs(row.aLonMax) <= c.STILL_IMU_MAX &&
      Math.abs(row.aLonMin) <= c.STILL_IMU_MAX &&
      Math.abs(row.aLatMax) <= c.STILL_IMU_MAX &&
      Math.abs(row.aLatMin) <= c.STILL_IMU_MAX &&
      Math.abs(row.yawRateMax) <= c.STILL_IMU_MAX &&
      Math.abs(row.jerkMax) <= c.STILL_IMU_MAX
    );
  }

  /** The cruise test for the middle of three contiguous rows (evaluated when the third arrives). */
  function cruiseSample(row: FeatureRow, gap: boolean): void {
    if (!(inEpoch && aligned(row) && !gap)) {
      cruiseWin = [];
      return;
    }
    cruiseWin.push(row);
    if (cruiseWin.length > 3) cruiseWin.shift();
    if (cruiseWin.length < 3) return;
    const [a, b, d] = cruiseWin as [FeatureRow, FeatureRow, FeatureRow];
    const va = kmh(a);
    const vb = kmh(b);
    const vd = kmh(d);
    if (va === null || vb === null || vd === null) return;
    if (vb < c.CRUISE_MIN_KMH) return;
    if (Math.abs(vb - va) >= c.CRUISE_MAX_DV_KMH || Math.abs(vd - vb) >= c.CRUISE_MAX_DV_KMH) return;
    if (a.course < 0 || b.course < 0 || d.course < 0) return;
    const r1 = Math.abs(wrapDeg(b.course - a.course)) / Math.max(1e-3, (b.ts - a.ts) / 1000);
    const r2 = Math.abs(wrapDeg(d.course - b.course)) / Math.max(1e-3, (d.ts - b.ts) / 1000);
    if (r1 >= c.CRUISE_MAX_COURSE_DEGS || r2 >= c.CRUISE_MAX_COURSE_DEGS) return;
    // Welford
    const x = aMean(b);
    bN += 1;
    const d1 = x - bMean;
    bMean += d1 / bN;
    bM2 += d1 * (x - bMean);
  }

  /** The sign check on a GNSS brake: Δv ≤ −SIGN_BRAKE_DV_KMH within SIGN_WINDOW_ROWS aligned rows. */
  function signSample(row: FeatureRow, gap: boolean): void {
    const v = kmh(row);
    if (!inEpoch || !aligned(row) || gap || v === null) {
      signWin = [];
      return;
    }
    signWin.push({ kmh: v, a: aMean(row) });
    if (signWin.length > c.SIGN_WINDOW_ROWS + 1) signWin.shift();
    if (signCooldown > 0) {
      signCooldown -= 1;
      return;
    }
    const lastIdx = signWin.length - 1;
    for (let j = 0; j < lastIdx; j++) {
      const dv = signWin[lastIdx]!.kmh - signWin[j]!.kmh;
      if (dv <= -c.SIGN_BRAKE_DV_KMH) {
        let sum = 0;
        for (let i = j + 1; i <= lastIdx; i++) sum += signWin[i]!.a;
        const predicted = KMH_PER_G_S * sum;
        const ok = predicted < 0 && Math.abs(predicted - dv) <= c.SIGN_TOLERANCE * Math.abs(dv);
        if (ok) signPass += 1;
        else signFail += 1;
        signCooldown = c.SIGN_WINDOW_ROWS;
        signWin = [];
        return;
      }
    }
  }

  function mount(row: FeatureRow, mounted: boolean): Pick<MotionEvidence, 'mountMatch' | 'mountAngleRad' | 'mountLostS' | 'mountQuiet'> {
    const g = gravityOf(row);
    const mountQuiet = typeof row.accRms === 'number' ? row.accRms < c.MOUNT_QUIET_G : null;
    if (mountRef === null && g !== null && mounted && row.handlingScore === 0 && row.gravityStability >= c.STILL_GRAVITY_MIN) {
      refRows.push(g);
      if (refRows.length >= c.MOUNT_REF_ROWS) {
        mountRef = normalize([median(refRows.map((v) => v[0])), median(refRows.map((v) => v[1])), median(refRows.map((v) => v[2]))]);
        refRows = [];
      }
    }
    if (mountRef === null || g === null) {
      mountLostS = 0;
      return { mountMatch: null, mountAngleRad: null, mountLostS, mountQuiet };
    }
    const ang = angle(mountRef, g);
    mountLostS = ang > c.MOUNT_LOST_RAD ? mountLostS + 1 : 0;
    return { mountMatch: ang <= c.MOUNT_MATCH_RAD && row.handlingScore === 0, mountAngleRad: ang, mountLostS, mountQuiet };
  }

  function onRow(row: FeatureRow, opts: { mounted?: boolean } = {}): MotionEvidence {
    if (prevTs !== null && row.ts <= prevTs && last !== null) return last;
    const gap = prevTs !== null && row.ts - prevTs > c.ROW_GAP_MS;

    // ——— the epoch ———
    const al = aligned(row);
    if (al && !inEpoch) {
      endEpoch();
      inEpoch = true;
    } else if (!al && inEpoch) {
      endEpoch();
    }
    cruiseSample(row, gap);
    signSample(row, gap);

    const v = kmh(row);
    const b = bHat();
    const d = aMean(row) - b;
    const quiet = isQuiet(row);
    const handling = row.handlingScore !== 0;
    const vehicleMotion = al && !handling && d >= c.STRONG_ALON_G;
    const strong = !handling && ((v !== null && v >= c.STOP_KMH) || vehicleMotion);
    const moving: MotionEvidence['moving'] = handling ? null : strong ? 'strong' : quiet ? null : 'weak';

    // ——— since the last known speed ———
    if (v !== null) {
      resetSinceFix();
      fix = { ts: row.ts, kmh: v, speedAcc: row.speedAcc >= 0 ? row.speedAcc : 0 };
      sinceFixOk = al && inEpoch;
    } else if (fix !== null) {
      if (!al || gap || !inEpoch) sinceFixOk = false;
      if (sinceFixOk) {
        if (d <= -c.BRAKE_EVIDENCE_G) {
          brakeRun += 1;
          brakeRunPeak = Math.min(brakeRunPeak, d);
          brakeRunPending += d;
          if (!brakeRunProven && brakeRun >= 2 && brakeRunPeak <= -c.BRAKE_PEAK_G) brakeRunProven = true;
          if (brakeRunProven) {
            // A proven braking run lowers v̂ by every row of it, the ones before the proof included.
            sumDelta += brakeRunPending;
            brakeRunPending = 0;
            brakingEpisode = true;
          }
        } else {
          // A run that never proved itself counts nothing (dropping negative rows only raises v̂); any
          // other row can only raise v̂ (R1-2a).
          brakeRun = 0;
          brakeRunPeak = 0;
          brakeRunPending = 0;
          brakeRunProven = false;
          sumDelta += Math.max(0, d);
        }
      }
    }

    // ——— the latch: exits first ———
    let endedByMotion = false;
    if (latched !== null) {
      if (v !== null || gap || (latched === 'sensor' && !al)) {
        latched = null;
      } else if (moving === 'strong') {
        latched = null;
        endedByMotion = true;
      } else if (moving === 'weak') {
        weakRun += 1;
        if (weakRun >= 2) {
          latched = null;
          endedByMotion = true;
        }
      } else if (moving === null && !handling) {
        weakRun = 0;
      }
    }
    if (latched === null) weakRun = 0;

    // ——— entering a sensor stop ———
    if (latched === null && !endedByMotion && v === null && fix !== null && trusted() && sinceFixOk && brakingEpisode) {
      const T = (row.ts - fix.ts) / 1000;
      const vHat = fix.kmh + KMH_PER_G_S * sumDelta;
      const u = Math.max(c.U0_MIN_KMH, c.U0_PER_SPEEDACC * fix.speedAcc) + KMH_PER_G_S * k() * T;
      if (T <= c.INFERRED_MAX_HORIZON_S && vHat + u <= c.STOP_KMH && quiet && prevQuiet && !gap) {
        latched = 'sensor';
        weakRun = 0;
        vLow = null;
      }
    }

    // ——— deep still (U-4: off by default) ———
    const deepRow =
      v === null &&
      typeof row.accRms === 'number' &&
      row.accRms <= c.DEEP_STILL_G &&
      row.yawRateMax <= c.DEEP_STILL_YAW_RADS &&
      row.gravityStability >= c.DEEP_STILL_GRAVITY_MIN &&
      !handling;
    deepS = deepRow && !gap ? deepS + 1 : 0;
    if (c.DEEP_STILL_ENABLED && latched === null && !endedByMotion && deepS >= c.DEEP_STILL_HOLD_S) {
      latched = 'deep';
      vLow = null;
    }

    // ——— vLow after a stop ended by motion (no fix) ———
    if (endedByMotion && v === null) vLow = { sum: 0, t: 0 };
    if (vLow !== null) {
      if (v !== null || gap || !al || !trusted()) vLow = null;
      else {
        // Robust to an unmeasured residual: acceleration counts only above the braking evidence and
        // minus RESIDUAL_MAX_G; small positive readings count nothing; negative readings count fully.
        vLow.sum += d >= c.BRAKE_EVIDENCE_G ? d - c.RESIDUAL_MAX_G : Math.min(0, d);
        vLow.t += 1;
        if (vLow.t > c.V_LOW_VALID_S) vLow = null;
      }
    }
    const vLowKmh = vLow === null ? null : Math.max(0, KMH_PER_G_S * (vLow.sum - k() * vLow.t));

    // ——— ambiguous stillness ———
    quietNoFixS = v === null && quiet && !gap ? quietNoFixS + 1 : 0;
    const stop: MotionEvidence['stop'] = v !== null ? (v < c.STOP_KMH ? 'gnss' : null) : latched;
    const ambiguousStill = v === null && stop === null && quietNoFixS >= c.AMBIGUOUS_HOLD_S;

    const ev: MotionEvidence = {
      stop,
      moving,
      quiet,
      vehicleMotion,
      ambiguousStill,
      quietNoFixS,
      vLowKmh,
      trust: trusted(),
      bias: bN > 0 ? { bHat: bMean, sigma: sigma(), n: bN } : null,
      ...mount(row, opts.mounted ?? false),
      gap,
    };
    prevTs = row.ts;
    prevQuiet = quiet && !gap;
    last = ev;
    return ev;
  }

  return {
    onRow,
    resetMountReference() {
      mountRef = null;
      refRows = [];
      mountLostS = 0;
    },
    reset,
  };
}
