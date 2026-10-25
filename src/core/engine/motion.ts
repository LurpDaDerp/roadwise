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
import type { MotionActivity } from '@drive-sense';
import { WALK_END_S, WALK_STAND_MIN_S } from '@scoring';

import { MPS_PER_MPH } from '@/core/detectors/common';

import type { TripSession } from './engine.types';
import { END_CRAWL_MPS, WALK_BAND_MPH } from './session';

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
