// What the phone's motion activity means for a drive (product spec v3 "Ending on its own"). Pure.
//
// The OS activity classifier (iOS Motion & Fitness, Android Physical activity; optional) measures no
// speed and no g-force. The engine uses it for one thing, the walking end (`machine.ts`):
// - A report counts only if its walk began after the car was last at driving speed
//   (`session.lastDroveAt`): two driving rows in a row, the second at or after the walk began, void
//   it for good, whenever the report arrives (before or after those rows).
// - W1: once the car has reached driving speed (`session.droveAt`), such a report that stays the
//   latest report for `WALK_CONFIRM_MS` ends the drive, unless the last known speed is driving speed
//   and `WALK_STALE_FIX_MS` old or less; the drive is cut at the last movement at or before the walk
//   began.
// - W2: a drive that has not reached driving speed is ended by such a report only once it is
//   `ON_FOOT_DROP_MS` old (and is then not kept).
// Without the permission no reports come and neither rule ever applies.
import type { MotionActivity } from '@drive-sense';

/** What one report says: on foot, nothing either way (a low-confidence walk), or not on foot. */
export type FootReading = 'onFoot' | 'unsure' | 'clear';

/** An on-foot report must stay the latest one this long (row clock) before it ends a drive. */
export const WALK_CONFIRM_MS = 20_000;
/** W2: a drive that never reached driving speed is ended on foot only once it is this old. */
export const ON_FOOT_DROP_MS = 600_000;
/** The last known speed is no longer the car's once its row is more than this old (parked where there is no sky). */
export const WALK_STALE_FIX_MS = 60_000;

/**
 * A walking or running report at medium confidence or more is on foot; at low confidence it says
 * nothing; an Android EXIT and every other type (automotive, stationary, cycling, unknown) clear.
 */
export function footReading(a: MotionActivity): FootReading {
  if (a.exit === true) return 'clear';
  if (a.type === 'walking' || a.type === 'running') return a.confidence === 'low' ? 'unsure' : 'onFoot';
  return 'clear';
}
