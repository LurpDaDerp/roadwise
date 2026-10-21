/**
 * "How points work": the onboarding explainer and the full rules in plain words. Every number is
 * read from @scoring, so the page can't drift from what the server actually scores.
 */
import {
  BASE_PENALTY,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  CHALLENGE_REWARD_POINTS,
  CLEAN_BONUS,
  CLEAN_BONUS_MIN_MILES,
  DAILY_FULL_MILES,
  DAILY_HALF_MILES,
  DASHCAM_DROWSY_GAP_S,
  DASHCAM_EYES_OFF_GAP_S,
  DASHCAM_MIN_COVERAGE,
  DASHCAM_MIN_MOVING_S,
  DASHCAM_MIN_MPH,
  DASHCAM_MULT,
  DISPUTE_AUTO_PER_WEEK,
  LEVEL_STEP,
  MAX_FREEZES,
  MERGE_GAP_S,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  MULT_CAP,
  NO_EVENTS_FIRST_S,
  NOT_DRIVING_PER_MONTH,
  POINTS_PER_MILE,
  RANKED_MIN_MILES,
  RATING_PENALTY,
  SPEEDING_EVENT_CAP,
  SPEEDING_GRACE_S,
  STREAK_MULT_CAP,
  STREAK_STEP,
  categoryScore,
  phoneSpeedMult,
  speedTolerance,
  speedingCost,
} from '@scoring';

import type { Ionicons } from '@expo/vector-icons';

type IconName = keyof typeof Ionicons.glyphMap;

const x = (m: number) => `×${m.toFixed(2)}`;
const streakCapDrives = Math.round((STREAK_MULT_CAP - 1) / STREAK_STEP);
/** "every 5 min" from seconds. */
const everyMin = (s: number) => `every ${Math.round(s / 60)} min`;
/** The phone speed bands in words, from the multiplier itself: "×1.5 over 25 mph and ×2 over 45 mph". */
const phoneSpeedBands = `×${phoneSpeedMult(26)} over 25 mph and ×${phoneSpeedMult(46)} over 45 mph`;
/** A category's score for one event every `miles` miles, as the rating section quotes it. */
const categoryExample = (penalty: number, miles: number) => Math.round(categoryScore(penalty, miles, RANKED_MIN_MILES));

/** The three ideas the onboarding "how it works" step and Home's first-run card show. */
export const HOW_IT_WORKS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'car-sport-outline', title: 'Safe miles earn points', body: `${POINTS_PER_MILE} points for every safe mile you drive.` },
  { icon: 'remove-circle-outline', title: 'Events cost points', body: 'Speeding, hard braking and phone use (even leaving RoadWise mid-drive) cost points.' },
  { icon: 'flame-outline', title: 'Streaks multiply', body: `Every good drive grows your streak and boosts what you earn, up to ${x(STREAK_MULT_CAP)}.` },
];

export type PenaltyRow = { event: string; penalty: string };

export const PENALTIES: PenaltyRow[] = [
  {
    event: 'Speeding',
    penalty: `−1 to −${SPEEDING_EVENT_CAP}, growing the further over the line you are and the longer you stay, after ${SPEEDING_GRACE_S} s of grace`,
  },
  { event: 'Hard braking', penalty: `−${BASE_PENALTY.hard_brake.minor} · severe −${BASE_PENALTY.hard_brake.severe}` },
  { event: 'Hard acceleration', penalty: `−${BASE_PENALTY.hard_accel.minor} · severe −${BASE_PENALTY.hard_accel.severe}` },
  { event: 'Hard cornering', penalty: `−${BASE_PENALTY.hard_corner.minor} · severe −${BASE_PENALTY.hard_corner.severe}` },
  {
    event: 'Phone pickup or leaving RoadWise',
    penalty: `−${BASE_PENALTY.phone_pickup} (−${BASE_PENALTY.phone_pickup_stopped} when stopped in traffic), ${phoneSpeedBands}`,
  },
  { event: 'Phone handling or time away', penalty: `−${BASE_PENALTY.phone_handling_per_unit} for every extra 15 s, ${phoneSpeedBands}` },
  { event: 'Eyes off road (DashPal)', penalty: `−${BASE_PENALTY.eyes_off}, at most once ${everyMin(DASHCAM_EYES_OFF_GAP_S)}` },
  { event: 'Drowsy (DashPal)', penalty: `−${BASE_PENALTY.drowsy}, at most once ${everyMin(DASHCAM_DROWSY_GAP_S)}` },
];

export type RuleSection = { id: string; title: string; icon: IconName; points: string[] };

export const RULES: RuleSection[] = [
  {
    id: 'points',
    title: 'Points per drive',
    icon: 'add-circle-outline',
    points: [
      `You get ${POINTS_PER_MILE} points for every safe mile: miles you weren't speeding or using your phone.`,
      `Finish a drive of ${CLEAN_BONUS_MIN_MILES} mi or more with zero events for a +${CLEAN_BONUS} clean-drive bonus. DashPal events don’t count against it.`,
      'Each event takes points off (see the list below).',
      'A second event of the same kind costs ×1.25, and a third or more costs ×1.5.',
      'Penalties are smaller on very short drives and count fully from 3 mi.',
      `A drive under ${MIN_SCORED_MILES} mi that takes under ${MIN_SCORED_S / 60} min isn't scored.`,
    ],
  },
  {
    id: 'phone',
    title: 'Phone use',
    icon: 'phone-portrait-outline',
    points: [
      'Lifting or handling your phone while driving is a phone pickup.',
      'Leaving RoadWise mid-drive counts as phone use too: another app, the home screen, and on Android the app switcher or split screen. Time away counts as handling until you come back or lock your phone, which can wait until you’ve stopped.',
      'The navigation button on the drive screen opens your navigation app and never costs points. If you lock your phone or come back to RoadWise, use the button again to reopen it. Going back any other way costs points.',
      'Locking your phone and the notification shade never count. Nor does a call’s own screen, but once you’re back in RoadWise for 10 s of the call, leaving again counts.',
      'On iPhone a switch counts once you come back to RoadWise after 15 s or more, or once you’ve been away about 26 s. One that began with an unlock outside RoadWise, or that a call cut short, needs about 26 s. A message lighting up the lock screen, or a quick lock and unlock, never counts. Switches count only once RoadWise can tell when your iPhone locks, which needs a passcode. Several short switches in a row count as one pickup (on iPhone, ones over about 11 s).',
      `Phone use costs more the faster you were going: ${phoneSpeedBands}. A pickup while stopped in traffic stays −${BASE_PENALTY.phone_pickup_stopped}.`,
    ],
  },
  {
    id: 'speeding',
    title: 'Speeding',
    icon: 'speedometer-outline',
    points: [
      `Speeding starts a few mph over the posted limit: ${speedTolerance(25)} over at 25 mph, ${speedTolerance(35)} at 35, ${speedTolerance(45)} at 45, ${speedTolerance(55)} at 55 and ${speedTolerance(65)} at 65 (${speedTolerance(25, 'school')} in a school or construction zone).`,
      `You hear a chime the moment you cross that line. The first ${SPEEDING_GRACE_S} s are free: slow down and it costs nothing.`,
      `After that it costs more the further over you are and the longer you stay, up to −${SPEEDING_EVENT_CAP} in one go. 10 s at 3 mph over is about −${speedingCost(10, 30)}; a minute at 3 over about −${speedingCost(60, 180)}.`,
    ],
  },
  {
    id: 'multipliers',
    title: 'Multipliers',
    icon: 'flash-outline',
    points: [
      `Each drive in your streak adds ${STREAK_STEP} to your multiplier, up to ${x(STREAK_MULT_CAP)} at a ${streakCapDrives}-drive streak.`,
      `A DashPal drive earns ${x(DASHCAM_MULT)} on top of that. Together they top out at ${x(MULT_CAP)}.`,
      'Multipliers only boost what you earn. Penalties never get bigger because of them.',
    ],
  },
  {
    id: 'dashpal',
    title: 'DashPal dashcam',
    icon: 'videocam-outline',
    points: [
      `A drive is a DashPal drive when DashPal watched you for at least ${Math.round(DASHCAM_MIN_COVERAGE * 100)}% of your time moving (at least ${DASHCAM_MIN_MOVING_S / 60} min) and your phone caught up with it by the end.`,
      `DashPal flags eyes off the road with no look back, or slumping out of view at speed (−${BASE_PENALTY.eyes_off}, at most once ${everyMin(DASHCAM_EYES_OFF_GAP_S)}), and drowsiness (−${BASE_PENALTY.drowsy}, at most once ${everyMin(DASHCAM_DROWSY_GAP_S)}).`,
      `They count only at ${DASHCAM_MIN_MPH} mph or more with good GPS, and not in the first ${NO_EVENTS_FIRST_S} s of a drive you started while stopped (unless your last drive ended within ${MERGE_GAP_S / 60} min).`,
      `DashPal may alarm below ${DASHCAM_MIN_MPH} mph; those alarms cost no points.`,
      'DashPal events never break a clean drive. They cost points like any event, and they count toward Attention in your Safety Rating.',
    ],
  },
  {
    id: 'cap',
    title: 'Daily mileage cap',
    icon: 'speedometer-outline',
    points: [
      `Your first ${DAILY_FULL_MILES} safe miles each day earn full points.`,
      `From ${DAILY_FULL_MILES} to ${DAILY_HALF_MILES} mi they earn half, and nothing after that.`,
      'Driving around just for points doesn’t pay.',
    ],
  },
  {
    id: 'streaks',
    title: 'Streaks and freezes',
    icon: 'flame-outline',
    points: [
      'Streaks count drives, not days. Every scored drive with positive points adds 1.',
      'A negative drive uses a freeze if you have one, so your streak holds but doesn’t grow. A streak of 0 never uses one.',
      'With no freeze, your streak is at risk: make your next drive clean (zero events) to save it, or it resets to 0.',
      `You start with 2 freezes and get 2 more every 30 days, holding up to ${MAX_FREEZES}.`,
      'Earn one for 5 clean drives in a row, and one for every 3 weekly challenges you finish.',
      'Freezes can’t be bought. Taking a break from driving never breaks a streak.',
    ],
  },
  {
    id: 'levels',
    title: 'Levels',
    icon: 'ribbon-outline',
    points: [
      'Your level follows your points total, so losing points can drop you a level. Your total never goes below 0.',
      `Level 2 is at ${LEVEL_STEP} points, level 3 at ${LEVEL_STEP * 3}, level 4 at ${(LEVEL_STEP * 6).toLocaleString('en-US')}, and each one after takes a bit more.`,
    ],
  },
  {
    id: 'rating',
    title: 'Safety Rating',
    icon: 'shield-checkmark-outline',
    points: [
      'Your Safety Rating is a score from 0 to 100 for how safely you drove over the last 30 days.',
      'It’s the average of the categories on your Analytics radar: speed, braking, acceleration, turning and phone use, plus Attention if you drive with DashPal. Speed and phone use count double.',
      'Each category scores how often its events happen per mile (Attention per mile DashPal watched). Streaks, multipliers and the time of day don’t affect it.',
      `One phone pickup every 10 mi scores phone use ${categoryExample(RATING_PENALTY.phone_pickup, 10)}. One hard brake every 20 mi scores braking about ${categoryExample(RATING_PENALTY.hard_brake.minor, 20)}.`,
      `You need ${RANKED_MIN_MILES} mi in the last 30 days to get a rating on the boards.`,
    ],
  },
  {
    id: 'boards',
    title: 'Leaderboards',
    icon: 'trophy-outline',
    points: [
      'The Friends board ranks you and your friends by points this week, or by Safety Rating.',
      'The global board ranks Safety Rating, for drivers with 100 mi or more in 30 days.',
      `Weekly challenges (3 a week) are worth +${CHALLENGE_REWARD_POINTS} points each.`,
    ],
  },
  {
    id: 'mistakes',
    title: 'If we got it wrong',
    icon: 'flag-outline',
    points: [
      'Every event in a drive’s breakdown has a Report link.',
      `"Braked for a hazard" and "wrong speed limit" are accepted right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
      `"DashPal got it wrong" is accepted right away too, up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of those.`,
      `"Wasn't driving" takes a whole drive off when someone else drove. You can use it ${NOT_DRIVING_PER_MONTH} times a month, on your latest drive.`,
      'Recorded drives can’t be deleted, so nobody can hide a bad drive.',
    ],
  },
];
