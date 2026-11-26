// Detection thresholds and drive rules. Shared by the device's detectors, the server's
// re-validation and the screens, so every number lives here once.

// The hard-event lines sit inside the range insurers, fleet telematics and driving research use for
// passenger cars (brake 0.32 to 0.61 g, start 0.35 to 0.50 g, turn 0.47 to 0.50 g): braking at the
// insurers' ~8 mph per second, starts and turns at the fleet and research norm.
/** Hard braking, in g: minor from 0.36, severe from 0.55 (confirmed by a GPS speed drop). */
export const HARD_BRAKE_G = { minor: 0.36, severe: 0.55 } as const;
/** Hard acceleration, in g: minor from 0.40, severe from 0.60. */
export const HARD_ACCEL_G = { minor: 0.4, severe: 0.6 } as const;
/** Hard cornering (sideways force), in g: minor from 0.48, severe from 0.70. */
export const HARD_CORNER_G = { minor: 0.48, severe: 0.7 } as const;
/** The car counts as moving at or above this speed (mph): moving time, harsh-event gates. */
export const MOVING_MIN_MPH = 5;

// Phone pickups (read from motion) go by the phone's tilt from each second's gravity direction, the way
// Android's tilt sensor and driving-distraction telematics do: shaking, rattling and vibration move
// the phone a lot but leave its tilt where it was; a pickup tilts it far from where it rested.
/**
 * A second is still when the phone's gravity direction moved no more than this (degrees) from the
 * reading before (at most 2 s before), and moving when it moved more; a shake within the second that
 * leaves the tilt where it was is still.
 */
export const PHONE_STILL_STEP_DEG = 3;
/**
 * This many still seconds in a row make the phone's resting tilt (their mean direction), which then
 * follows slow drift. A pickup still open when the phone comes to rest was put down where the rest began.
 */
export const PHONE_SETTLE_S = 10;
/** A second counts toward a pickup only with the phone tilted at least this far (degrees) from its resting tilt… */
export const PHONE_TILT_MIN_DEG = 30;
/** …and held the way a phone is held to be looked at: its screen tilted up from lying flat by this much (degrees)… */
export const PHONE_VIEW_TILT_DEG = { min: 15, max: 80 } as const;
/** …with its top turned no further than this (degrees) from straight up within the screen (on its side is 90, upside down 180). */
export const PHONE_VIEW_ROLL_MAX_DEG = 120;
/** Driving speed for phone use (mph, a known, trusted GPS speed): a pickup counts only once the phone is away at this speed. */
export const PHONE_PICKUP_MIN_MPH = 10;
/** A pickup needs at least this many use seconds (moving seconds with the phone away, and steady ones that count). */
export const PHONE_PICKUP_MIN_ROWS = 3;
/**
 * The phone is put down once this many seconds of row clock pass after the last second it was away
 * with no new one; a second away within them continues the same pickup (never a second one).
 */
export const PHONE_PUTDOWN_QUIET_S = 10;
/** A pickup in hand up to this many seconds is moderate; longer is severe. */
export const PHONE_SEVERE_S = 15;
/** A speeding episode ends after this long back under the speeding line less `SPEEDING_END_BUFFER_MPH`. */
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

export type AchievementId =
  | 'first_drive'
  | 'clean_100'
  | 'clean_500'
  | 'clean_1000'
  | 'perfect_week'
  | 'rain_or_shine'
  | 'better_speed'
  | 'better_braking'
  | 'better_acceleration'
  | 'better_turning'
  | 'better_phone'
  | 'better_attention'
  | 'spot_cleared';
export interface Achievement {
  id: AchievementId;
  title: string;
  description: string;
}

/** A category score must rise at least this much (whole points) over `IMPROVEMENT_DAYS` for its badge. */
export const IMPROVEMENT_POINTS = 10;
/** How far back the improvement badges compare a category score. */
export const IMPROVEMENT_DAYS = 30;

/**
 * The 13 achievements (badges; they reward nothing), in the order the app lists them. The server
 * unlocks all but Spot Cleared, which the phone claims (spots never leave the phone). Rain or Shine
 * reads the weather the phone tagged the drive with (trips.weather).
 */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first_drive', title: 'First Drive', description: 'Complete a scored drive.' },
  { id: 'clean_100', title: 'Clean 100', description: 'Drive 100 clean miles.' },
  { id: 'clean_500', title: 'Clean 500', description: 'Drive 500 clean miles.' },
  { id: 'clean_1000', title: 'Clean 1,000', description: 'Drive 1,000 clean miles.' },
  { id: 'perfect_week', title: 'Perfect Week', description: 'Take 3 or more drives in a week, all with zero events.' },
  { id: 'rain_or_shine', title: 'Rain or Shine', description: 'Finish a clean drive in rain or snow.' },
  { id: 'better_speed', title: 'Easing Off', description: 'Raise your Speed score by 10 in 30 days.' },
  { id: 'better_braking', title: 'Softer Stops', description: 'Raise your Braking score by 10 in 30 days.' },
  { id: 'better_acceleration', title: 'Gentle Starts', description: 'Raise your Acceleration score by 10 in 30 days.' },
  { id: 'better_turning', title: 'Smooth Turns', description: 'Raise your Turning score by 10 in 30 days.' },
  { id: 'better_phone', title: 'Hands on the Wheel', description: 'Raise your Phone use score by 10 in 30 days.' },
  { id: 'better_attention', title: 'Eyes Ahead', description: 'Raise your Attention score by 10 in 30 days.' },
  { id: 'spot_cleared', title: 'Spot Cleared', description: 'Clear a spot to watch.' },
];
