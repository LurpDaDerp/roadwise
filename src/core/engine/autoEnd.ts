// The automatic ends of a recording trip (DMS calib T14; rev4 §2.13, rev5 §1 and §4.1, controller amendment R5-1).
// M3-local constants (packages/scoring is unchanged: AUTO_END_STATIONARY_S stays for the §8.7 break clock and the
// server) and a pure per-row tracker the machine feeds while `recording`.
//
// - **A standstill** is a run of rows with stop evidence or a known speed < 0.5 m/s. It breaks only on movement
//   evidence (WK-2, rev5 R4-m1): 5 consecutive rows ≥ 0.5 m/s; 3 such rows with a displacement > max(10 m, hAcc)
//   from the run's anchor; a displacement > max(25 m, 2·hAcc); or one strong vehicle row. A single noisy row, or a
//   multipath run of a few seconds, never breaks it.
// - **Its end** is graded by whether the driver is in the seat (`driverPresent`, from the DMS): absent (false) 10 min,
//   a deep still (U-4) 10 min, unknown (null) 20 min, present (true) 30 min.
// - **No fix and AMBIGUOUS_STILL only** (no stop evidence): 30 min, so a smooth tunnel never ends a drive.
// - **Pedestrian** (WK-1, rev5 R4-1): 5 min of slow or unknown speed, no automotive activity, no strong vehicle row,
//   no driver in the seat, gait (accRms ≥ WALK_RMS_G on ≥ 60 % of the rows), and leaving: sustained handling
//   (handlingScore > 0 on ≥ 50 % of the rows of the last minute) or the mount lost for a minute.
// - **No movement at all** (R5-1): 60 min without a row ≥ 2.2 m/s or a strong vehicle row, whatever else: every
//   open trip is bounded, even with old rows (no accRms) or no IMU.
// Every end trims to where driving stopped (§2.13.5): the standstill's start, the walk's start, or just past the last
// vehicle movement, whichever is first. The trip stays reversible for GAP_MERGE_S (10 min).
import { CONSTANTS } from '@scoring';
import { knownSpeed } from '@/core/detectors/common';
import { haversineMeters } from '@/lib/geo';
import type { EndCause, RowEvidence } from './engine.types';
import type { FeatureRow } from './types';

const { LOCKOUT_SPEED_MPS } = CONSTANTS;

export const AUTO_END = Object.freeze({
  /** Standstill ends (rev4 §2.13.3) */
  STANDSTILL_END_EMPTY_S: 600,
  STANDSTILL_END_DEEP_S: 600,
  STANDSTILL_END_UNKNOWN_S: 1200,
  STANDSTILL_END_PRESENT_S: 1800,
  /** No fix, AMBIGUOUS_STILL only */
  NO_FIX_AMBIGUOUS_END_S: 1800,
  /** The pedestrian end's window */
  PEDESTRIAN_END_S: 300,
  /** Below this a known speed is a standstill row */
  STANDSTILL_SPEED_MPS: 0.5,
  /** The break (rev5 §4.1): this many consecutive moving rows */
  STANDSTILL_BREAK_ROWS: 5,
  /** …or this many with a displacement beyond max(STANDSTILL_BREAK_NEAR_M, hAcc) */
  STANDSTILL_BREAK_NEAR_ROWS: 3,
  STANDSTILL_BREAK_NEAR_M: 10,
  /** …or a displacement beyond max(STANDSTILL_BREAK_M, 2·hAcc) */
  STANDSTILL_BREAK_M: 25,
  /** The drive host's walk confirmation (rev4 §2.12.2); here for the pedestrian window's validation */
  WALK_CONFIRM_S: 20,
  /** Gait (rev5 R4-1; set from K11) */
  WALK_RMS_G: 0.12,
  GAIT_ROW_FRAC: 0.6,
  /** Sustained handling */
  HANDLING_ROW_FRAC: 0.5,
  HANDLING_MIN_S: 60,
  /** The mount lost this long */
  MOUNT_LOST_HOLD_S: 60,
  /** R5-1: the catch-all */
  NO_MOVEMENT_END_S: 3600,
  /** A row gap longer than this breaks the pedestrian window's contiguity */
  PEDESTRIAN_MAX_ROW_GAP_S: 5,
});

export type AutoEndConfig = { readonly [K in keyof typeof AUTO_END]: number };

/** The validation of rev4 §2.13.7 and rev5 §1 (`deepStillG` and `mountQuietG` from the motion evidence). */
export function validateAutoEnd(c: AutoEndConfig, motion: { deepStillG: number; mountQuietG: number }): string[] {
  const bad: string[] = [];
  const minEnd = 300;
  if (!(c.STANDSTILL_END_EMPTY_S >= minEnd)) bad.push('STANDSTILL_END_EMPTY_S: must be ≥ 300');
  if (!(c.STANDSTILL_END_DEEP_S >= minEnd)) bad.push('STANDSTILL_END_DEEP_S: must be ≥ 300');
  if (!(c.STANDSTILL_END_UNKNOWN_S >= c.STANDSTILL_END_EMPTY_S)) bad.push('STANDSTILL_END_UNKNOWN_S: must be ≥ STANDSTILL_END_EMPTY_S');
  if (!(c.STANDSTILL_END_PRESENT_S >= c.STANDSTILL_END_UNKNOWN_S)) bad.push('STANDSTILL_END_PRESENT_S: must be ≥ STANDSTILL_END_UNKNOWN_S');
  if (!(c.NO_FIX_AMBIGUOUS_END_S >= 600)) bad.push('NO_FIX_AMBIGUOUS_END_S: must be ≥ 600');
  if (!(c.PEDESTRIAN_END_S >= c.WALK_CONFIRM_S * 5)) bad.push('PEDESTRIAN_END_S: must be ≥ WALK_CONFIRM_S × 5');
  if (!(c.STANDSTILL_BREAK_ROWS >= 2)) bad.push('STANDSTILL_BREAK_ROWS: must be ≥ 2');
  if (!(c.STANDSTILL_BREAK_NEAR_ROWS >= 2 && c.STANDSTILL_BREAK_NEAR_ROWS <= c.STANDSTILL_BREAK_ROWS)) bad.push('STANDSTILL_BREAK_NEAR_ROWS: must be in [2, STANDSTILL_BREAK_ROWS]');
  if (!(c.STANDSTILL_BREAK_M >= 10)) bad.push('STANDSTILL_BREAK_M: must be ≥ 10');
  if (!(c.WALK_RMS_G > motion.deepStillG && c.WALK_RMS_G < 0.3)) bad.push('WALK_RMS_G: must be > DEEP_STILL_G and < 0.3');
  if (!(motion.mountQuietG < c.WALK_RMS_G)) bad.push('MOUNT_QUIET_G: must be < WALK_RMS_G');
  if (!(c.GAIT_ROW_FRAC > 0.5 && c.GAIT_ROW_FRAC <= 1)) bad.push('GAIT_ROW_FRAC: must be in (0.5, 1]');
  if (!(c.HANDLING_ROW_FRAC > 0 && c.HANDLING_ROW_FRAC <= 1)) bad.push('HANDLING_ROW_FRAC: must be in (0, 1]');
  if (!(c.HANDLING_MIN_S <= c.PEDESTRIAN_END_S)) bad.push('HANDLING_MIN_S: must be ≤ PEDESTRIAN_END_S');
  if (!(c.NO_MOVEMENT_END_S >= c.STANDSTILL_END_PRESENT_S)) bad.push('NO_MOVEMENT_END_S: must be ≥ STANDSTILL_END_PRESENT_S');
  return bad;
}

/**
 * The evidence a row carries into M3. Without the drive host's (old hosts, replays of plain rows): a stop only from a
 * known slow speed, no strong row, the engine's own fix-less stillness as the ambiguous one, no mount, no presence.
 */
export function evidenceOf(row: FeatureRow, given: RowEvidence | undefined, stillWithoutFix: (r: FeatureRow) => boolean): RowEvidence {
  if (given !== undefined) return given;
  const speed = knownSpeed(row);
  return {
    stop: speed !== null && speed < AUTO_END.STANDSTILL_SPEED_MPS ? 'gnss' : null,
    vehicleMotion: false,
    ambiguousStill: stillWithoutFix(row),
    mountLostS: 0,
    driverPresent: null,
  };
}

/** A decision to end: the cause, and where driving stopped (the trim). */
export interface AutoEndDecision {
  cause: EndCause;
  stoppedAt: number;
}

interface PedRow {
  ts: number;
  fast: boolean;
  vehicle: boolean;
  present: boolean;
  gait: boolean;
  handled: boolean;
}

/** The per-trip tracker. `row` returns an end to take, or null. */
export function createAutoEnd(c: AutoEndConfig = AUTO_END) {
  let standstill: { startTs: number; anchor: { lat: number; lng: number } | null; movingRun: number } | null = null;
  let ambiguousSinceTs: number | null = null;
  /** the trim's last vehicle movement: a row ≥ 2.2 m/s or a strong vehicle row */
  let lastVehicleMotionTs: number | null = null;
  /** R5-1's clock: the same rows ("whatever the other evidence says") */
  let lastFastTs: number | null = null;
  let lastAutomotiveTs: number | null = null;
  let startTs: number | null = null;
  const ped: PedRow[] = [];

  function reset(): void {
    standstill = null;
    ambiguousSinceTs = null;
    lastVehicleMotionTs = null;
    lastFastTs = null;
    lastAutomotiveTs = null;
    startTs = null;
    ped.length = 0;
  }

  /** Just past the last vehicle movement, or the trip's start when it never moved. */
  const pastMovement = (): number => (lastVehicleMotionTs !== null ? lastVehicleMotionTs + 1000 : (startTs ?? 0));

  function row(r: FeatureRow, ev: RowEvidence, rowMs: number): AutoEndDecision | null {
    startTs ??= r.ts;
    const speed = knownSpeed(r);
    if ((speed !== null && speed >= LOCKOUT_SPEED_MPS) || ev.vehicleMotion) {
      lastVehicleMotionTs = r.ts;
      lastFastTs = r.ts;
    }

    // The standstill run and its break (rev5 §4.1).
    const stillRow = ev.stop !== null || (speed !== null && speed < c.STANDSTILL_SPEED_MPS);
    if (standstill === null) {
      if (stillRow) standstill = { startTs: r.ts, anchor: r.gnssValid ? { lat: r.lat, lng: r.lng } : null, movingRun: 0 };
    } else {
      if (standstill.anchor === null && r.gnssValid) standstill.anchor = { lat: r.lat, lng: r.lng };
      // a GNSS stop (below 10 km/h) is a crawl too: the break reads the speed, whatever the stop evidence
      const moving = speed !== null && speed >= c.STANDSTILL_SPEED_MPS;
      standstill.movingRun = moving ? standstill.movingRun + 1 : 0;
      const disp = standstill.anchor !== null && r.gnssValid ? haversineMeters(standstill.anchor, { lat: r.lat, lng: r.lng }) : 0;
      const hAcc = Number.isFinite(r.hAcc) && r.hAcc > 0 ? r.hAcc : 0;
      const broken =
        ev.vehicleMotion ||
        standstill.movingRun >= c.STANDSTILL_BREAK_ROWS ||
        (standstill.movingRun >= c.STANDSTILL_BREAK_NEAR_ROWS && disp > Math.max(c.STANDSTILL_BREAK_NEAR_M, hAcc)) ||
        disp > Math.max(c.STANDSTILL_BREAK_M, 2 * hAcc);
      // Deviation (stated): a break is not itself "vehicle movement" for the trim: walking away breaks a standstill
      // too (5 rows at 1.3 m/s, 25 m of displacement), and the walked tail must never be counted (S-END-CARRY).
      if (broken) standstill = null;
    }
    ambiguousSinceTs = ev.ambiguousStill ? (ambiguousSinceTs ?? r.ts) : null;

    // The pedestrian window (rev5 §1).
    ped.push({
      ts: r.ts,
      fast: speed !== null && speed >= LOCKOUT_SPEED_MPS,
      vehicle: ev.vehicleMotion,
      present: ev.driverPresent === true,
      gait: typeof r.accRms === 'number' && r.accRms >= c.WALK_RMS_G,
      handled: r.handlingScore > 0,
    });
    while (ped.length > 0 && (ped[0] as PedRow).ts <= r.ts - c.PEDESTRIAN_END_S * 1000) ped.shift();

    const through = r.ts + rowMs;
    // 1. The standstill, graded by presence (rev4 §2.13.3).
    if (standstill !== null) {
      const heldS = (through - standstill.startTs) / 1000;
      const graded: [EndCause, number] =
        ev.driverPresent === false
          ? ['standstill_empty', c.STANDSTILL_END_EMPTY_S]
          : ev.driverPresent === true
            ? ['standstill_present', c.STANDSTILL_END_PRESENT_S]
            : ev.stop === 'deep'
              ? ['standstill_deep', c.STANDSTILL_END_DEEP_S]
              : ['standstill_unknown', c.STANDSTILL_END_UNKNOWN_S];
      if (heldS >= graded[1]) return { cause: graded[0], stoppedAt: Math.min(standstill.startTs, pastMovement()) };
    }
    // 2. No fix, AMBIGUOUS_STILL only.
    if (ambiguousSinceTs !== null && through - ambiguousSinceTs >= c.NO_FIX_AMBIGUOUS_END_S * 1000) {
      return { cause: 'no_fix_ambiguous', stoppedAt: Math.min(ambiguousSinceTs, pastMovement()) };
    }
    // 3. Pedestrian.
    if (pedestrian(r, ev, through)) return { cause: 'pedestrian', stoppedAt: pastMovement() };
    // 4. The catch-all (R5-1).
    const since = lastFastTs ?? startTs;
    if (through - since >= c.NO_MOVEMENT_END_S * 1000) return { cause: 'no_movement', stoppedAt: pastMovement() };
    return null;
  }

  function pedestrian(r: FeatureRow, ev: RowEvidence, through: number): boolean {
    if (ped.length === 0) return false;
    const first = ped[0] as PedRow;
    // the window covers PEDESTRIAN_END_S of contiguous rows
    if (through - first.ts < c.PEDESTRIAN_END_S * 1000) return false;
    let gait = 0;
    for (let i = 0; i < ped.length; i++) {
      const p = ped[i] as PedRow;
      if (i > 0 && p.ts - (ped[i - 1] as PedRow).ts > c.PEDESTRIAN_MAX_ROW_GAP_S * 1000) return false;
      if (p.fast || p.vehicle || p.present) return false; // clauses 1, 3, 4
      if (p.gait) gait++;
    }
    if (lastAutomotiveTs !== null && lastAutomotiveTs > r.ts - c.PEDESTRIAN_END_S * 1000) return false; // clause 2
    if (gait < c.GAIT_ROW_FRAC * ped.length) return false; // clause 5
    // clause 6: leaving, (a) sustained handling over the last HANDLING_MIN_S, or (b) the mount lost
    const recent = ped.filter((p) => p.ts > r.ts - c.HANDLING_MIN_S * 1000);
    const handled = recent.filter((p) => p.handled).length;
    const sustained = recent.length > 0 && handled >= c.HANDLING_ROW_FRAC * recent.length;
    return sustained || ev.mountLostS >= c.MOUNT_LOST_HOLD_S;
  }

  return {
    row,
    reset,
    /** An automotive activity while recording (the pedestrian end's clause 2). */
    automotive(ts: number): void {
      lastAutomotiveTs = ts;
    },
    /**
     * Where a walking end's driving stopped (rev4 §2.13.5): the first of the walk's start, the open standstill's start
     * and just past the last vehicle movement; undefined when none is known (the machine's own trim then applies).
     */
    walkStoppedAt(walkStartTs: number | undefined): number | undefined {
      const candidates: number[] = [];
      if (walkStartTs !== undefined) candidates.push(walkStartTs);
      if (standstill !== null) candidates.push(standstill.startTs);
      if (lastVehicleMotionTs !== null) candidates.push(lastVehicleMotionTs + 1000);
      return candidates.length > 0 ? Math.min(...candidates) : undefined;
    },
    lastVehicleMotionTs: (): number | null => lastVehicleMotionTs,
    standstillSinceTs: (): number | null => standstill?.startTs ?? null,
  };
}

export type AutoEnd = ReturnType<typeof createAutoEnd>;
