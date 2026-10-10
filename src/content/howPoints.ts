/**
 * "How points work": the onboarding explainer and the full rules in plain words. Every number is
 * read from @scoring, so the page can't drift from what the server actually scores.
 */
import {
  BASE_PENALTY,
  CLEAN_BONUS,
  CLEAN_BONUS_MIN_MILES,
  DAILY_FULL_MILES,
  DAILY_HALF_MILES,
  DISPUTE_AUTO_PER_WEEK,
  LEVEL_STEP,
  MAX_FREEZES,
  MIN_SCORED_MILES,
  NOT_DRIVING_PER_MONTH,
  POINTS_PER_MILE,
  RANKED_MIN_MILES,
  STREAK_MULT_CAP,
  STREAK_STEP,
} from '@scoring';

import type { Ionicons } from '@expo/vector-icons';

type IconName = keyof typeof Ionicons.glyphMap;

const x = (m: number) => `×${m.toFixed(2)}`;
const streakCapDrives = Math.round((STREAK_MULT_CAP - 1) / STREAK_STEP);

/** The three ideas the onboarding "how it works" step and Home's first-run card show. */
export const HOW_IT_WORKS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'car-sport-outline', title: 'Safe miles earn points', body: `${POINTS_PER_MILE} points for every safe mile you drive.` },
  { icon: 'remove-circle-outline', title: 'Events cost points', body: 'Speeding, hard braking and phone pickups take points off.' },
  { icon: 'flame-outline', title: 'Streaks multiply', body: `Every good drive grows your streak and boosts what you earn, up to ${x(STREAK_MULT_CAP)}.` },
];

export type PenaltyRow = { event: string; penalty: string };

export const PENALTIES: PenaltyRow[] = [
  {
    event: 'Speeding',
    penalty: `−${BASE_PENALTY.speeding.minor} minor · −${BASE_PENALTY.speeding.moderate} moderate · −${BASE_PENALTY.speeding.severe} severe, +25% for every extra 30 s`,
  },
  { event: 'Hard braking', penalty: `−${BASE_PENALTY.hard_brake.minor} · severe −${BASE_PENALTY.hard_brake.severe}` },
  { event: 'Hard acceleration', penalty: `−${BASE_PENALTY.hard_accel.minor} · severe −${BASE_PENALTY.hard_accel.severe}` },
  { event: 'Hard cornering', penalty: `−${BASE_PENALTY.hard_corner.minor} · severe −${BASE_PENALTY.hard_corner.severe}` },
  { event: 'Phone pickup', penalty: `−${BASE_PENALTY.phone_pickup} (−${BASE_PENALTY.phone_pickup_stopped} when stopped in traffic)` },
  { event: 'Phone handling', penalty: `−${BASE_PENALTY.phone_handling_per_unit} for every extra 15 s` },
];

export type RuleSection = { id: string; title: string; icon: IconName; points: string[] };

export const RULES: RuleSection[] = [
  {
    id: 'points',
    title: 'Points per drive',
    icon: 'add-circle-outline',
    points: [
      `You get ${POINTS_PER_MILE} points for every safe mile: miles you weren't speeding or using your phone.`,
      `Finish a drive of ${CLEAN_BONUS_MIN_MILES} mi or more with zero events for a +${CLEAN_BONUS} clean-drive bonus.`,
      'Each event takes points off (see the list below).',
      'A second event of the same kind costs ×1.25, and a third or more costs ×1.5.',
      'On very short drives, penalties are scaled down so one slip doesn’t hit as hard. They count fully from 3 mi.',
      `Drives under ${MIN_SCORED_MILES} mi aren't scored.`,
    ],
  },
  {
    id: 'multipliers',
    title: 'Streak multiplier',
    icon: 'flash-outline',
    points: [
      `Each drive in your streak adds ${STREAK_STEP} to your multiplier, up to ${x(STREAK_MULT_CAP)} at a ${streakCapDrives}-drive streak.`,
      'The multiplier only boosts what you earn. Penalties never get bigger because of your streak.',
    ],
  },
  {
    id: 'cap',
    title: 'Daily mileage cap',
    icon: 'speedometer-outline',
    points: [
      `Your first ${DAILY_FULL_MILES} safe miles each day earn full points.`,
      `From ${DAILY_FULL_MILES} to ${DAILY_HALF_MILES} mi they earn half, and nothing after that.`,
      'Driving around just for points doesn’t pay. Driving well does.',
    ],
  },
  {
    id: 'streaks',
    title: 'Streaks and freezes',
    icon: 'flame-outline',
    points: [
      'Streaks count drives, not days. Every scored drive with positive points adds 1.',
      'A negative drive uses a freeze if you have one. Your streak holds, it just doesn’t grow that time.',
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
      'Levels are based on all the points you’ve ever earned, so a bad drive never costs you a level.',
      `Level 2 is at ${LEVEL_STEP} points, level 3 at ${LEVEL_STEP * 3}, level 4 at ${(LEVEL_STEP * 6).toLocaleString('en-US')}, and each one after takes a bit more.`,
    ],
  },
  {
    id: 'rating',
    title: 'Safety Rating',
    icon: 'shield-checkmark-outline',
    points: [
      'Your Safety Rating is a score from 0 to 100 for how safely you drove over the last 30 days.',
      'It counts penalty points per 100 miles, with no streaks or multipliers, so it measures your driving and nothing else.',
      'One hard brake every 20 mi works out to about 95. One phone pickup every 10 mi drops it to 60.',
      `You need ${RANKED_MIN_MILES} mi in the last 30 days to get a rating on the boards.`,
    ],
  },
  {
    id: 'leagues',
    title: 'Leagues',
    icon: 'trophy-outline',
    points: [
      'Each week you’re in a league of 30 drivers in your tier, ranked by points earned that week.',
      'Weeks run Monday to Monday. The top 7 move up a tier and the bottom 5 move down. You need 3 drives to move up.',
      'Tiers go Bronze, Silver, Gold, Platinum, Diamond.',
      'The global board ranks Safety Rating instead, for drivers with 100 mi or more in 30 days.',
      'Weekly challenges (3 a week) are worth +100 points each.',
    ],
  },
  {
    id: 'mistakes',
    title: 'If we got it wrong',
    icon: 'flag-outline',
    points: [
      'Every event in a drive’s breakdown has a Report link.',
      `"Braked for a hazard" and "wrong speed limit" are accepted right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
      `"Wasn't driving" takes a whole drive off when someone else drove. You can use it ${NOT_DRIVING_PER_MONTH} times a month, on your latest drive.`,
      'Recorded drives can’t be deleted, so nobody can hide a bad drive.',
    ],
  },
];
