// Detection thresholds and drive rules. Shared by the device's detectors, the server's
// re-validation and the screens, so every number lives here once.

/** Hard braking, in g: minor from 0.30, severe from 0.45 (confirmed by a GPS speed drop). */
export const HARD_BRAKE_G = { minor: 0.3, severe: 0.45 } as const;
/** Hard acceleration, in g: minor from 0.32, severe from 0.45. */
export const HARD_ACCEL_G = { minor: 0.32, severe: 0.45 } as const;
/** Hard cornering (sideways force), in g. */
export const HARD_CORNER_G = { minor: 0.4, severe: 0.55 } as const;
/** The car counts as moving at or above this speed (mph): moving time, harsh-event gates. */
export const MOVING_MIN_MPH = 5;

/**
 * Phone use (motion only): a row whose handling score is at least this reads as the phone in the
 * driver's hand (a use row).
 */
export const PHONE_HANDLING_MIN_SCORE = 0.6;
/** Driving speed for phone use (mph, a known, trusted GPS speed): a pickup counts only once one of its use rows is this fast. */
export const PHONE_PICKUP_MIN_MPH = 10;
/** A pickup needs at least this many use rows. */
export const PHONE_PICKUP_MIN_ROWS = 3;
/**
 * The phone is put down once this many seconds of row clock pass after the last use row with no new
 * one; a use row within them continues the same pickup (never a second one).
 */
export const PHONE_PUTDOWN_QUIET_S = 10;
/** A pickup in hand up to this many seconds is moderate; longer is severe. */
export const PHONE_SEVERE_S = 15;
/** A speeding episode ends after this long back under L + T − `SPEEDING_END_BUFFER_MPH`. */
export const SPEEDING_END_S = 5;
export const SPEEDING_END_BUFFER_MPH = 2;
/**
 * No hard brake, start or turn in the first 30 s of a drive started from a standstill (the phone
 * settling into its mount). Speeding, phone pickups and DashPal events count from the first row.
 */
export const NO_EVENTS_FIRST_S = 30;
/** GPS accuracy worse than this (m) records no speeding and shows "—". */
export const MAX_H_ACC_M = 20;
/**
 * A drive ends on its own after this long without the car moving (the clock starts when the car
 * stops moving and resets the moment it moves again), cut back to its last movement.
 */
export const IDLE_END_S = 300;
/** At or under this speed (mph) the car is crawling: with walking confirmed, the drive ends. */
export const END_CRAWL_MPH = 3;
/**
 * The walking end: a confident walking or running report ends a drive once the car has stopped (the
 * driver has left the car) this long (s) after the walk began, as the phone dates it, and once the
 * report has stood `WALK_STAND_MIN_S`. The native safety stop takes a walk standing this long
 * `END_NATIVE_WALK_SLACK_S` later.
 */
export const WALK_END_S = 10;
/** The walking end's floor: the on-foot report must have stood this long (s) since it arrived. */
export const WALK_STAND_MIN_S = 3;
/** The native safety stop's slack over the JS still end (s): it fires only when JS has not ended the drive. */
export const END_NATIVE_SLACK_S = 60;
/** The native safety stop's slack over the JS walking end (s): it fires only when JS has not ended the drive. */
export const END_NATIVE_WALK_SLACK_S = 10;
/**
 * A drive started within this gap (s) of the previous drive's end has no warm-up (`continues`);
 * native's warm-up hint also needs the start within `MERGE_RADIUS_M` of that end. Every drive is
 * a drive of its own, however soon and near it starts.
 */
export const MERGE_GAP_S = 300;
/** The distance (m) from the previous drive's end to the next drive's start for native's warm-up hint. */
export const MERGE_RADIUS_M = 150;
/** The privacy trim: the route's first and last this many metres are cut before upload. */
export const TRIM_ENDS_M = 402;
/**
 * A drive under `MIN_SCORED_MILES` miles AND under `MIN_SCORED_S` seconds is not scored (kept and
 * listed, "Too short to score"). Either one reached makes it a scored drive.
 */
export const MIN_SCORED_MILES = 0.5;
export const MIN_SCORED_S = 120;
/** "Wasn't driving" uses per month. */
export const NOT_DRIVING_PER_MONTH = 2;
/** "Wasn't driving" is offered until this long (s) after the drive's end. */
export const NOT_DRIVING_WINDOW_S = 86_400;
/** "Braked for a hazard" / "wrong speed limit" disputes auto-accepted per week. */
export const DISPUTE_AUTO_PER_WEEK = 3;

/** DashPal events score only at this phone GPS speed or faster, on a good fix. */
export const DASHCAM_MIN_MPH = 10;
/** A DashPal drive needs at least this many seconds moving at 5 mph or more… */
export const DASHCAM_MIN_MOVING_S = 60;
/** …with the dashcam watching the driver for at least this share of them. */
export const DASHCAM_MIN_COVERAGE = 0.8;
/** "DashPal got it wrong" reports auto-accepted per week, a quota of its own beside `DISPUTE_AUTO_PER_WEEK`. */
export const CAMERA_DISPUTE_AUTO_PER_WEEK = 3;

export type AchievementId = 'first_drive' | 'clean_100' | 'perfect_week';
export interface Achievement {
  id: AchievementId;
  title: string;
  description: string;
}

/** The three achievements (badges; they reward nothing). */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first_drive', title: 'First Drive', description: 'Complete a scored drive.' },
  { id: 'clean_100', title: 'Clean 100', description: 'Drive 100 clean miles.' },
  { id: 'perfect_week', title: 'Perfect Week', description: 'Take 3 or more drives in a week, all with zero events.' },
];
