// What the phone's motion activity means for a drive (product spec v3 "Ending on its own"). Pure.
//
// The OS activity classifier (iOS Motion & Fitness, Android Physical activity; optional) measures no
// speed and no g-force. The engine uses it for one thing, the walking end (`machine.ts`):
// - A report counts only if its walk began after the car was last at driving speed
//   (`session.lastDroveAt`): two driving rows in a row, the second at or after the walk began, void
//   it for good, whenever the report arrives (before or after those rows).
// - W1: once the car has reached driving speed (`session.droveAt`), such a report that stays the
//   latest report ends the drive `WALK_END_MS` (10 s, `WALK_END_S`) after its walk began, as the
//   phone dates it, and never before it has stood `WALK_STAND_MIN_MS` (3 s, `WALK_STAND_MIN_S`),
//   unless the car is still driving: its last known speed over 3 mph (`END_CRAWL_MPH`) and
//   `WALK_STALE_FIX_MS` (15 s) old or less, a walker's own pace (at most 5 mph with the phone
//   carried) excepted (`carStillDriving`); the drive is cut at the last movement at or before the
//   walk began.
// - W2: a drive that has not reached driving speed is ended by such a report only once it is
//   `ON_FOOT_DROP_MS` old (and is then not kept).
// Without the permission no reports come and neither rule ever applies.
//
// Two more automatic ends read the phone's own senses (`machine.ts`):
// - The step walk (iOS): `STEP_WALK_MIN` (15) steps or more within `STEP_WINDOW_MS` (20 s) on the
//   rows' pedometer count (`FeatureRow.steps`), with no trusted fix over 3 mph in the last
//   `STEP_CALM_MS` (15 s), is a walking end, cut at the last movement at or before the first of
//   those steps. The W2 age applies as on a report.
// - The known parking spot: stopped (no trusted fix over 3 mph) for `PARK_STOP_MS` (60 s), the last
//   fix within `PARK_NEAR_M` (75 m) of where one of the last `PARK_SPOTS_MAX` (50) kept drives ended
//   or of a saved place, and no confident in-a-vehicle report standing or arriving in those 60 s:
//   the drive ends as a still end (`stopped`), cut at the stop. Only once the drive has reached
//   driving speed, and never on a replayed row (no motion reports come with one).
// - The car link (iOS): the paired car or CarPlay gone `CAR_GONE_MS` (15 s) continuously during a
//   drive that had it (native's debounced "gone since", the host's `deps.carGoneSince`), with no
//   trusted fix over 3 mph since it went: a still end (`stopped`), cut at the last movement. A
//   disconnect while the car moves never ends a drive; a reconnect clears it. Never on a replayed row.
// While a Start-card drive still waits for driving speed none of them applies.
import type { MotionActivity } from '@drive-sense';
import { WALK_END_S, WALK_STAND_MIN_S } from '@scoring';

import { knownSpeed, MPS_PER_MPH, speedTrusted } from '@/core/detectors/common';
import { haversineMeters } from '@/lib/geo';

import type { TripSession } from './engine.types';
import { END_CRAWL_MPS, WALK_BAND_MPH } from './session';
import type { FeatureRow } from './types';

/** What one report says: on foot, nothing either way (a low-confidence walk), or not on foot. */
export type FootReading = 'onFoot' | 'unsure' | 'clear';

/** A standing on-foot report ends a drive this long (row clock) after its walk began (the report's own date). */
export const WALK_END_MS = WALK_END_S * 1000;
/** ...and never before it has stood this long (row clock) since it arrived. */
export const WALK_STAND_MIN_MS = WALK_STAND_MIN_S * 1000;
/** W2: a drive that never reached driving speed is ended on foot only once it is this old. */
export const ON_FOOT_DROP_MS = 600_000;
/** The last known speed is no longer the car's once its row is more than this old (parked where there is no sky). */
export const WALK_STALE_FIX_MS = 15_000;

/**
 * A walking or running report at medium confidence or more is on foot; at low confidence it says
 * nothing; an Android EXIT and every other type (automotive, stationary, cycling, unknown) clear.
 */
export function footReading(a: MotionActivity): FootReading {
  if (a.exit === true) return 'clear';
  if (a.type === 'walking' || a.type === 'running') return a.confidence === 'low' ? 'unsure' : 'onFoot';
  return 'clear';
}

/** A walker's own pace tops out here (`WALK_BAND_MPH.max`, 5 mph): a carried phone this slow is a person, not the car. */
export const WALKER_PACE_MAX_MPS = WALK_BAND_MPH.max * MPS_PER_MPH;

/**
 * W1's guard at `t` (row clock): the car may still be driving, so an on-foot report must not end the
 * drive. True while the last known GPS speed is over 3 mph (`END_CRAWL_MPS`) and at most
 * `WALK_STALE_FIX_MS` old, unless that reading is a walker's own: at most 5 mph
 * (`WALKER_PACE_MAX_MPS`) from a phone that read as carried (handling, an unsteady gravity vector or
 * a turning phone). A mounted or cup-holder phone in a car creeping at 3 to 5 mph keeps the guard;
 * a phone in a pocket or a hand walking off at 3.4 mph does not. Running pace (over 5 mph) keeps it.
 */
export function carStillDriving(last: TripSession['lastSpeed'], t: number): boolean {
  if (last === null || !(last.mps > END_CRAWL_MPS) || t - last.ts > WALK_STALE_FIX_MS) return false;
  return !(last.carried && last.mps <= WALKER_PACE_MAX_MPS);
}

// --- the step walk ------------------------------------------------------------------------------

/** The step walk: this many steps or more on the rows' pedometer count… */
export const STEP_WALK_MIN = 15;
/** …within this long (row clock, between two rows' counts)… */
export const STEP_WINDOW_MS = 20_000;
/** …with no trusted fix over 3 mph in this long (the last 15 rows). */
export const STEP_CALM_MS = 15_000;

/** One row's pedometer count, at the row's own time. */
export interface StepMark {
  ts: number;
  steps: number;
}

/** A row with a known, trusted GPS speed over 3 mph (`END_CRAWL_MPS`): the car may be moving. */
export function fastRow(row: FeatureRow): boolean {
  const s = knownSpeed(row);
  return s !== null && s > END_CRAWL_MPS && speedTrusted(row);
}

/**
 * The step log after `row`: its count added (a row without one changes nothing), the counts more
 * than `STEP_WINDOW_MS` older than it dropped. A count lower than the last one is a pedometer that
 * started again (a relaunch): the log starts again from it. Never mutates `log`.
 */
export function noteSteps(log: readonly StepMark[], row: Pick<FeatureRow, 'ts' | 'steps'>): StepMark[] {
  const steps = row.steps;
  if (steps === undefined || !Number.isSafeInteger(steps) || steps < 0) return log.slice();
  const last = log[log.length - 1];
  if (last !== undefined && steps < last.steps) return [{ ts: row.ts, steps }];
  if (last !== undefined && row.ts <= last.ts) return log.slice();
  return [...log.filter((m) => m.ts >= row.ts - STEP_WINDOW_MS), { ts: row.ts, steps }];
}

/**
 * The step walk in `log` (`noteSteps`): `STEP_WALK_MIN` steps or more between its oldest count and
 * its newest, all within `STEP_WINDOW_MS`. `since`: the last row still at the oldest count, the
 * last moment before the first of those steps (the walking end's cut lands at or before it). Null
 * with no such walk. Pure.
 */
export function stepWalk(log: readonly StepMark[]): { since: number } | null {
  const first = log[0];
  const last = log[log.length - 1];
  if (first === undefined || last === undefined || last.steps - first.steps < STEP_WALK_MIN) return null;
  let since = first.ts;
  for (const m of log) {
    if (m.steps !== first.steps) break;
    since = m.ts;
  }
  return { since };
}

/** The car has had no trusted fix over 3 mph in the `STEP_CALM_MS` up to `t` (row clock); `lastFastAt` is the last such row's time. */
export const calmFor = (lastFastAt: number | null, t: number, ms: number): boolean => lastFastAt === null || t - lastFastAt > ms;

// --- the car link -------------------------------------------------------------------------------

/** The car-link end: the paired car or CarPlay gone this long, with no trusted fix over 3 mph since. */
export const CAR_GONE_MS = 15_000;

/**
 * The car-link end at `t` (row clock): gone since `goneSince` (at or after the drive's start, so an
 * old reading never counts) for `CAR_GONE_MS` or more, and no trusted fix over 3 mph since it went
 * (`lastFastAt` before it).
 */
export function carGoneEnds(goneSince: number | null, startedAt: number, lastFastAt: number | null, t: number): boolean {
  if (goneSince === null || goneSince < startedAt || t - goneSince < CAR_GONE_MS) return false;
  return lastFastAt === null || lastFastAt < goneSince;
}

// --- the known parking spot -----------------------------------------------------------------------

/** The known parking spot: stopped this long (no trusted fix over 3 mph)… */
export const PARK_STOP_MS = 60_000;
/** …within this far of a known spot… */
export const PARK_NEAR_M = 75;
/** …the ends of this many of the latest kept drives (and the saved places). */
export const PARK_SPOTS_MAX = 50;

export interface Spot {
  lat: number;
  lng: number;
}

/** What one report says of a car: in one (automotive at medium confidence or more), nothing either way (automotive at low), or not in one. */
export type VehicleReading = 'vehicle' | 'unsure' | 'clear';

export function vehicleReading(a: MotionActivity): VehicleReading {
  if (a.exit === true) return 'clear';
  if (a.type === 'automotive') return a.confidence === 'low' ? 'unsure' : 'vehicle';
  return 'clear';
}

/** `here` is within `PARK_NEAR_M` of one of `spots`. */
export function nearSpot(here: Spot, spots: readonly Spot[]): boolean {
  for (const p of spots) if (haversineMeters(here, p) <= PARK_NEAR_M) return true;
  return false;
}
