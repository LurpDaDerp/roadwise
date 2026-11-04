// "Where you parked" (iPhone with the car link, round 14): after a kept drive, the spot is stored
// only when the paired car went off the route with the car standing still and the driver then
// walked away from it. Pure: the host feeds the drive's rows, the car link and the live motion
// reports, and stores the spot on `confirmed` (`src/features/parked/model.ts`).
//
// Armed at the end of a kept drive when:
// - a paired car was connected during the drive and then left the route (T, the tally's time the
//   last paired car went) while the drive still recorded or within 30 s after it closed;
// - the car stood still at T: its last trusted GPS speed before T was 1 mph or less, and no row
//   from T to the drive's close was over walking pace (5 mph). Or, when T came after the car's last
//   movement (the drive's cut, where the engine ended it): a trusted reading of 1 mph or less after
//   that movement, up to the close, and nothing over walking pace from it to the close. The trail
//   holds the phone's speed, so a driver already walking off as the car's Bluetooth went leaves
//   walking-pace rows before T; the car itself had stopped at its cut;
// - the car's last-moved point (the drive's end) was fixed to 20 m or better, more than 150 m from
//   every saved place.
// Then the motion reports decide (they keep coming for about 3 min after an automatic end):
// - the walk W starts with the first walking or running report (medium or high confidence) at or
//   after T, and no later than T + 3 min, or at T itself when the newest report before T was a walk
//   (the driver walked off before the car's Bluetooth went, as with the walking end); a stationary,
//   automotive or cycling report (medium+) breaks a walk that has not held 15 s yet; low-confidence
//   and unknown reports change nothing;
// - confirmed once a walk has held 15 s and it is W + 60 s, with no automotive or cycling report
//   (medium+) from T on and no drive started;
// - an automotive or cycling report, a new drive, or no confirmation by T + 4 min: dropped.
import type { MotionActivity } from '@drive-sense';

import type { FeatureRow } from '@/core/engine/types';
import { haversineMeters, type LatLng } from '@/lib/geo';
import { mphToMps } from '@/lib/units';

/** The car may leave the route this long after the drive closed. */
export const PARKED_LEAVE_GRACE_MS = 30_000;
/** The car's last trusted speed before it left the route: at most 1 mph. */
export const PARKED_STOPPED_MPS = 0.45;
/** No row after it left may be over walking pace. */
export const PARKED_WALK_PACE_MPS = mphToMps(5);
/** The end point's GPS accuracy: this or better. */
export const PARKED_FIX_ACC_M = 20;
/** No card at (or near) a saved place: the end point is more than this from every one. */
export const PARKED_PLACE_M = 150;
/** The walk must begin within this of the car leaving the route. */
export const PARKED_WALK_START_MS = 3 * 60_000;
/** The walk holds this long. */
export const PARKED_WALK_MS = 15_000;
/** No car motion from the car leaving until this long after the walk began. */
export const PARKED_CALM_MS = 60_000;
/** Not confirmed by this long after the car left the route: dropped. */
export const PARKED_GIVE_UP_MS = 4 * 60_000;
/** Rows kept for the checks (about 25 min at 1 Hz, past the 5-minute still end). */
export const PARKED_TRAIL_ROWS = 1500;

interface TrailRow {
  ts: number;
  hAcc: number;
  gnssValid: boolean;
  /** The known, trusted GPS speed (m/s), or null. */
  speed: number | null;
}

/** A trusted GPS speed: known, with a speed accuracy of 2 m/s or better (or none reported). */
const trustedSpeed = (row: Pick<FeatureRow, 'gnssValid' | 'speed' | 'speedAcc'>): number | null =>
  row.gnssValid && row.speed >= 0 && (row.speedAcc === -1 || (row.speedAcc >= 0 && row.speedAcc <= 2)) ? row.speed : null;

/** The drive's latest rows, for the arming checks. */
export interface RowTrail {
  push(row: Pick<FeatureRow, 'ts' | 'hAcc' | 'gnssValid' | 'speed' | 'speedAcc'>): void;
  reset(): void;
  /**
   * The car stood still at `leftAt`: its last trusted speed before was ≤ 1 mph, and no row from
   * `leftAt` to `until` was over walking pace. Or, with `lastMovedAt` (the drive's cut, the car's
   * last movement) before `leftAt`: a trusted ≤ 1 mph reading after it up to `until`, and no row
   * after it up to `until` over walking pace (the phone may walk away before the car left).
   */
  stoppedAt(leftAt: number, until: number, lastMovedAt?: number | null): boolean;
  /** The GPS accuracy (m) of the valid fix at `ts`, or null when the trail has none there. */
  accuracyAt(ts: number): number | null;
}

export function createRowTrail(max = PARKED_TRAIL_ROWS): RowTrail {
  let rows: TrailRow[] = [];
  return {
    push(row) {
      rows.push({ ts: row.ts, hAcc: row.hAcc, gnssValid: row.gnssValid, speed: trustedSpeed(row) });
      if (rows.length > max) rows = rows.slice(rows.length - max);
    },
    reset() {
      rows = [];
    },
    stoppedAt(leftAt, until, lastMovedAt = null) {
      // The trail must reach back before the car left: otherwise its speed then is unknown.
      const first = rows[0];
      if (first === undefined || first.ts >= leftAt) return false;
      let before: number | null = null;
      let fastAfter = false;
      for (const r of rows) {
        if (r.ts < leftAt) {
          if (r.speed !== null) before = r.speed;
        } else if (r.ts <= until && r.speed !== null && r.speed > PARKED_WALK_PACE_MPS) {
          fastAfter = true;
          break;
        }
      }
      if (fastAfter) return false;
      if (before !== null && before <= PARKED_STOPPED_MPS) return true;
      // The car's last movement came before it left: the car stopped there, whatever the phone did after.
      if (lastMovedAt === null || !(lastMovedAt < leftAt) || first.ts > lastMovedAt) return false;
      let still = false;
      for (const r of rows) {
        if (r.ts <= lastMovedAt || r.ts > until || r.speed === null) continue;
        if (r.speed > PARKED_WALK_PACE_MPS) return false;
        if (r.speed <= PARKED_STOPPED_MPS) still = true;
      }
      return still;
    },
    accuracyAt(ts) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i] as TrailRow;
        if (r.ts === ts) return r.gnssValid && Number.isFinite(r.hAcc) && r.hAcc >= 0 ? r.hAcc : null;
        if (r.ts < ts) return null;
      }
      return null;
    },
  };
}

/** The end point is fixed well enough (≤ 20 m) and more than 150 m from every saved place. */
export function spotQualifies(point: LatLng, accuracyM: number | null, places: readonly LatLng[]): boolean {
  if (accuracyM === null || !(accuracyM <= PARKED_FIX_ACC_M)) return false;
  return places.every((p) => haversineMeters(point, p) > PARKED_PLACE_M);
}

export type ParkedOutcome = 'watching' | 'confirmed' | 'dropped';

export interface ParkedWatch {
  /** When the car left the route. */
  readonly leftAt: number;
  /** A live motion report (its own `ts`), heard at host time `at`. */
  activity(a: MotionActivity, at: number): ParkedOutcome;
  /** Time passed (a timer, or any event). */
  tick(at: number): ParkedOutcome;
  /** A drive started. */
  driveStarted(): ParkedOutcome;
  /** When the outcome may next change on time alone, or null once decided. */
  dueAt(): number | null;
  outcome(): ParkedOutcome;
}

const sure = (a: MotionActivity): boolean => a.confidence === 'medium' || a.confidence === 'high';

export function createParkedWatch(leftAt: number): ParkedWatch {
  let outcome: ParkedOutcome = 'watching';
  /** The walk under way (its first report's time), or null. */
  let walkFrom: number | null = null;
  /** The walk that held 15 s (its start): the calm runs to 60 s after it. */
  let heldFrom: number | null = null;
  /** A sure report from T on came in: an older one (heard late) no longer changes the walk. */
  let heardAfter = false;

  function settle(at: number): ParkedOutcome {
    if (outcome !== 'watching') return outcome;
    if (heldFrom === null && walkFrom !== null && at - walkFrom >= PARKED_WALK_MS) heldFrom = walkFrom;
    if (heldFrom !== null && at >= heldFrom + PARKED_CALM_MS) outcome = 'confirmed';
    else if (at - leftAt >= PARKED_GIVE_UP_MS) outcome = 'dropped';
    return outcome;
  }

  return {
    leftAt,
    activity(a, at) {
      if (outcome !== 'watching') return outcome;
      // Android's walk exit, and a low-confidence report: nothing here.
      if (a.exit === true || !sure(a)) return settle(at);
      if (a.ts < leftAt) {
        // Before the car left: a walk still standing then (the driver got out and walked off before
        // the car's Bluetooth went) is under way at T, so it counts from T. Anything else said
        // since ends that.
        if (heldFrom === null && !heardAfter) walkFrom = a.type === 'walking' || a.type === 'running' ? leftAt : a.type === 'unknown' ? walkFrom : null;
        return settle(at);
      }
      heardAfter = true;
      if (a.type === 'automotive' || a.type === 'cycling') {
        outcome = 'dropped';
        return outcome;
      }
      if (heldFrom === null) {
        if (a.type === 'walking' || a.type === 'running') {
          if (walkFrom === null && a.ts - leftAt <= PARKED_WALK_START_MS) walkFrom = a.ts;
        } else if (a.type === 'stationary') {
          // A walk breaks before it held: the next one (still within 3 min) starts again.
          if (walkFrom !== null && a.ts - walkFrom < PARKED_WALK_MS) walkFrom = null;
        }
      }
      return settle(at);
    },
    tick: (at) => settle(at),
    driveStarted() {
      if (outcome === 'watching') outcome = 'dropped';
      return outcome;
    },
    dueAt() {
      if (outcome !== 'watching') return null;
      const giveUp = leftAt + PARKED_GIVE_UP_MS;
      if (heldFrom !== null) return Math.min(heldFrom + PARKED_CALM_MS, giveUp);
      if (walkFrom !== null) return Math.min(walkFrom + PARKED_WALK_MS, giveUp);
      return giveUp;
    },
    outcome: () => outcome,
  };
}
