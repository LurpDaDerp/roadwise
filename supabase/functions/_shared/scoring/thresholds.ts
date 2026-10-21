// v3 detection thresholds and game constants (product spec v3, plan §2). Shared by the device's
// detectors, the server's re-validation and the screens, so every number lives here once.

/** Hard braking, in g: minor from 0.30, severe from 0.45 (confirmed by a GPS speed drop). */
export const HARD_BRAKE_G = { minor: 0.3, severe: 0.45 } as const;
/** Hard acceleration, in g: minor from 0.32, severe from 0.45. */
export const HARD_ACCEL_G = { minor: 0.32, severe: 0.45 } as const;
/** Hard cornering (sideways force), in g. */
export const HARD_CORNER_G = { minor: 0.4, severe: 0.55 } as const;
/** Phone pickups count only while moving above this speed. */
export const PHONE_MIN_MPH = 5;
/**
 * The grace on speeding: an episode is an event only once it has MORE than this many rows over the
 * points line (L + T), whatever its tier (the 6th row makes it one), and the cost counts the rows
 * after these (`speedingChargedS`). An episode that never gets there is never an event, costs
 * nothing and does not break a clean drive. The alert sounds on the first over row, so the driver
 * has this long to react before points come off.
 */
export const SPEEDING_GRACE_S = 5;
/**
 * @deprecated Superseded by `SPEEDING_GRACE_S` (the event starts on the row after the grace, for
 * every tier). Kept only until the speeding detector reads the grace; nothing else may use it.
 */
export const SPEEDING_MIN_S = { default: 4, severe: 3 } as const;
/** A speeding episode ends after this long back under L + T − `SPEEDING_END_BUFFER_MPH`. */
export const SPEEDING_END_S = 5;
export const SPEEDING_END_BUFFER_MPH = 2;
/** No events in the first 30 s of a drive. */
export const NO_EVENTS_FIRST_S = 30;
/** GPS accuracy worse than this (m) records no speeding and shows "—". */
export const MAX_H_ACC_M = 20;
/** A drive ends on its own after this long without the car moving, cut back to its last movement. */
export const IDLE_END_S = 900;
/** Ending then restarting within this gap and distance merges into one drive. */
export const MERGE_GAP_S = 300;
export const MERGE_DIST_M = 402;
/**
 * A drive under `MIN_SCORED_MILES` miles AND under `MIN_SCORED_S` seconds is not scored (kept and
 * listed, "Too short to score"). Either one reached makes it a scored drive.
 */
export const MIN_SCORED_MILES = 0.5;
export const MIN_SCORED_S = 120;
/** Points for finishing a weekly challenge (the server pays it; the client copy reads it here). */
export const CHALLENGE_REWARD_POINTS = 200;
/** "Wasn't driving" uses per month. */
export const NOT_DRIVING_PER_MONTH = 2;
/** "Braked for a hazard" / "wrong speed limit" disputes auto-accepted per week. */
export const DISPUTE_AUTO_PER_WEEK = 3;
/** Freezes held at most. */
export const MAX_FREEZES = 3;

/** DashPal events score only at this phone GPS speed or faster, on a good fix. */
export const DASHCAM_MIN_MPH = 10;
/** At most one `drowsy` per this many seconds of a drive (the earliest is kept). */
export const DASHCAM_DROWSY_GAP_S = 600;
/** At most one `eyes_off` per this many seconds of a drive (the earliest is kept). */
export const DASHCAM_EYES_OFF_GAP_S = 300;
/** A DashPal drive needs at least this many seconds moving at 5 mph or more… */
export const DASHCAM_MIN_MOVING_S = 60;
/** …with the dashcam watching the driver for at least this share of them. */
export const DASHCAM_MIN_COVERAGE = 0.8;
/** An eyes-off event within this many seconds of a phone pickup or handling event is dropped: the phone already charged it. */
export const DASHCAM_PHONE_OVERLAP_S = 5;
/** "DashPal got it wrong" reports auto-accepted per week, a quota of its own beside `DISPUTE_AUTO_PER_WEEK`. */
export const CAMERA_DISPUTE_AUTO_PER_WEEK = 3;

/** Weekly league tiers, lowest first. */
export const LEAGUE_TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;
export type LeagueTier = (typeof LEAGUE_TIERS)[number];

export type AchievementId = 'first_drive' | 'clean_100' | 'perfect_week' | 'phone_free_25' | 'streak_10';
export interface Achievement {
  id: AchievementId;
  title: string;
  description: string;
}

/** The launch set of 5 achievements. */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first_drive', title: 'First Drive', description: 'Complete a scored drive.' },
  { id: 'clean_100', title: 'Clean 100', description: 'Drive 100 clean miles.' },
  { id: 'perfect_week', title: 'Perfect Week', description: 'Take 3 or more drives in a week, all with zero events.' },
  { id: 'phone_free_25', title: 'Phone-Free 25', description: 'Take 25 drives in a row with no phone pickups.' },
  { id: 'streak_10', title: 'Streak 10', description: 'Reach a 10-drive streak.' },
];
