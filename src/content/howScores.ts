/**
 * "How scores work": the three ideas Home and the screen show, and the full rules in plain words.
 * Every number is read from a constant (the scoring package, or the drive rules the screen hands
 * in), so the page can't drift from what the app and the server actually do.
 */
import type { Ionicons } from '@expo/vector-icons';

import { hudCopy } from '@/features/drive/hudCopy';
import {
  AXES,
  AXIS_WEIGHT,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DASHCAM_MIN_MPH,
  DISPUTE_AUTO_PER_WEEK,
  IDLE_END_S,
  MERGE_GAP_S,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  NOT_DRIVING_PER_MONTH,
  PHONE_PICKUP_MIN_MPH,
  PHONE_PICKUP_WEIGHT_S,
  PHONE_PUTDOWN_QUIET_S,
  RANKED_MIN_MILES,
  RATING_WINDOW_DAYS,
  SPEED_FACTOR,
  speedTolerance,
  type AxisKey,
} from '@scoring';

/** The driving screen's own words for its "Not driving?" link, quoted wherever the rules name it. */
const ND = hudCopy.notDriving;

export type IconName = keyof typeof Ionicons.glyphMap;

export interface HowItem {
  icon: IconName;
  title: string;
  body: string;
}

export interface RuleSection {
  id: string;
  title: string;
  icon: IconName;
  lines: string[];
}

/** The drive rules the rules quote that live outside the scoring package (the screen reads them from the drive code). */
export interface DriveNumbers {
  /** Only over this speed (mph) does a drive start on its own… */
  autoMinMph: number;
  /** …after holding it this long (s) just over it… */
  autoMaxHoldS: number;
  /** …this much less (s)… */
  autoStepS: number;
  /** …for every this much faster (mph)… */
  autoStepMph: number;
  /** …and right away from this speed (mph). */
  autoInstantMph: number;
  /** How long a Start drive waits for the car to move, min. */
  waitMin: number;
  /** How long "Not driving?" lasts on the drive screen, min. */
  notDrivingMin: number;
}

const IDLE_MIN = Math.round(IDLE_END_S / 60);
const MERGE_MIN = Math.round(MERGE_GAP_S / 60);

/** Each category as a sentence names it. */
const AXIS_WORD: Record<AxisKey, string> = {
  acceleration: 'starts',
  braking: 'braking',
  turning: 'turns',
  attention: 'attention',
  phone: 'phone use',
  speed: 'speed',
};
const TIMES: Record<number, string> = { 2: 'double', 3: 'triple' };

/** "Speed and phone use count double.": the categories that weigh more than one, from `AXIS_WEIGHT`. */
function heavierLine(): string {
  const groups = new Map<number, string[]>();
  for (const a of AXES) {
    const w = AXIS_WEIGHT[a];
    if (w > 1) groups.set(w, [...(groups.get(w) ?? []), AXIS_WORD[a]]);
  }
  return [...groups]
    .map(([w, names]) => {
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]!;
      return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${names.length > 1 ? 'count' : 'counts'} ${TIMES[w] ?? `${w} times`}.`;
    })
    .join(' ');
}

/** The three ideas: Home's How it works card and the top of How scores work. */
export const howItWorks = (autoDrives: boolean): HowItem[] => [
  autoDrives
    ? { icon: 'car-sport-outline', title: 'Drives record themselves', body: `Once you’re on the road, RoadWise starts recording. Riding along? Tap “${ND}”.` }
    : { icon: 'car-sport-outline', title: 'Start, then drive', body: 'Swipe Start drive before you pull out. RoadWise records until you park.' },
  { icon: 'speedometer-outline', title: 'Every drive gets a score', body: 'Gentle stops, smooth starts, easy turns, staying near the limit and leaving your phone alone all help.' },
  {
    icon: 'shield-checkmark-outline',
    title: 'Grow your Safety Rating',
    body: `It sums up your last ${RATING_WINDOW_DAYS} days. See how it compares on the Friends tab.`,
  },
];

export const HERO = {
  title: 'Smooth and steady wins',
  body: `Every drive gets a score out of 100. Your Safety Rating sums up your last ${RATING_WINDOW_DAYS} days.`,
} as const;

/** Every rule, in plain words, worded for how drives start on this phone. */
export const rules = (autoDrives: boolean, n: DriveNumbers): RuleSection[] => [
  {
    id: 'drive-score',
    title: 'Your drive score',
    icon: 'speedometer-outline',
    lines: [
      'Every drive gets a score from 0 to 100 for braking, starts, turns, speed and phone use, plus attention when DashPal rides along. A drive with no events scores 100.',
      'Each one is judged against your chances: hard brakes against the times you slowed down, hard starts against the times you sped up, and sharp turns against the real turns you made. A busy city drive isn’t marked down just for having more stops.',
      'Speed is judged by how much of your driving time with a known limit you spent over it, and by how far over.',
      'Every event counts, and a more serious one counts more: a harder brake, start or turn, a longer or faster stretch over the limit, a longer pickup or one at a higher speed. Each is weighed against the whole drive, so one event marks a long drive down less than a short one.',
      autoDrives
        ? `A drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving gets no score. If you started it with Start drive, it isn’t saved at all.`
        : `A drive under ${MIN_SCORED_MILES} mi with under ${MIN_SCORED_S / 60} min of driving isn’t saved at all.`,
      'The score’s colour and icon show how a drive went for its length: a short perfect drive stays humble, a long smooth one earns the top.',
    ],
  },
  {
    id: 'speeding',
    title: 'Speeding',
    icon: 'speedometer-outline',
    lines: [
      `Speeding starts a few mph over the posted limit: ${speedTolerance(25)} over at 25 mph, ${speedTolerance(35)} at 35, ${speedTolerance(45)} at 45, ${speedTolerance(55)} at 55 and ${speedTolerance(65)} at 65 (${speedTolerance(25, 'school')} in a school or construction zone).`,
      `You hear a chime and see “${hudCopy.alert.speeding}” when you cross that line. Every second over it counts, and more the further over you are.`,
      'Where the limit isn’t known, nothing counts as speeding.',
    ],
  },
  {
    id: 'phone',
    title: 'Phone use',
    icon: 'phone-portrait-outline',
    lines: [
      'RoadWise feels for your phone being picked up while you drive, from its motion alone. It never sees your screen, your apps or your messages.',
      `A pickup counts once the car is going ${PHONE_PICKUP_MIN_MPH} mph or more. Pick it up at a red light and put it down before you pull away, and it doesn’t count.`,
      `Every second it stays in your hand while you’re moving adds to it. Put it down and pick it up again within ${PHONE_PUTDOWN_QUIET_S} s and it’s still one pickup.`,
      `Each pickup weighs ${PHONE_PICKUP_WEIGHT_S} s plus its time in hand, and more the faster you were going (twice as much at ${2 * SPEED_FACTOR.refMph} mph as at ${SPEED_FACTOR.refMph}), judged against your time at driving speed, so a long drive isn’t marked down for being long.`,
      `With the drive screen open, you hear a tone and see “${hudCopy.alert.phone_pickup}”. With RoadWise in the background, you get a quiet notification instead.`,
    ],
  },
  {
    id: 'rating',
    title: 'Safety Rating',
    icon: 'shield-checkmark-outline',
    lines: [
      `Your Safety Rating rolls your last ${RATING_WINDOW_DAYS} days of drives into one score from 0 to 100.`,
      'Recent weeks count more, so better habits show up quickly and an old rough day fades.',
      `It’s the average of your braking, starts, turns, speed, phone use and, with DashPal, attention scores. ${heavierLine()}`,
      'New drivers start from a typical driver’s score, so one rough drive early on won’t sink you.',
      'It’s fair to city and highway drivers alike, because each part is judged against your chances, not your miles.',
      `You get a rating once you’ve driven ${RANKED_MIN_MILES} mi in the last ${RATING_WINDOW_DAYS} days.`,
      'The time of day and how far you drive don’t change it.',
    ],
  },
  autoDrives
    ? {
        id: 'drives',
        title: 'How drives start and end',
        icon: 'car-sport-outline',
        lines: [
          `Once you’re over ${n.autoMinMph} mph, RoadWise starts recording after about ${n.autoMaxHoldS} s, ${n.autoStepS} s sooner for every ${n.autoStepMph} mph faster, and right away from ${n.autoInstantMph} mph. Short stops in traffic don’t reset it, and the drive counts from the moment you set off.`,
          `It ends once you park and walk away, or after ${IDLE_MIN} min parked.`,
          `Stop for under ${MERGE_MIN} min and set off again from the same spot, and it stays one drive.`,
          `Riding along? Open the drive screen and tap “${ND}”. It shows once the car reaches driving speed, for your first ${n.notDrivingMin} minutes on that screen.`,
          `Want to get set before you leave? Swipe Start drive on Home. RoadWise waits up to ${n.waitMin} min for you to get moving.`,
        ],
      }
    : {
        id: 'drives',
        title: 'Starting a drive',
        icon: 'car-sport-outline',
        lines: [
          `Swipe Start drive on Home before you pull out. RoadWise waits up to ${n.waitMin} min for you to get moving.`,
          `It records until you swipe End drive, park and walk away, or stay parked for ${IDLE_MIN} min.`,
          `Riding along? Tap “${ND}” on the drive screen. It shows once the car reaches driving speed, for your first ${n.notDrivingMin} minutes on that screen.`,
        ],
      },
  {
    id: 'dashpal',
    title: 'DashPal dashcam',
    icon: 'videocam-outline',
    lines: [
      'With a DashPal, eyes off the road and drowsiness count toward Attention, only on the miles it watched.',
      `They count only at ${DASHCAM_MIN_MPH} mph or more with good GPS. Each one counts more the faster you were going and the longer it lasted.`,
      'DashPal may alarm at lower speeds, even stopped. Those alarms don’t count.',
      'Without a DashPal, Attention is left out and your rating comes from the rest.',
    ],
  },
  {
    id: 'goals',
    title: 'Weekly goals and badges',
    icon: 'ribbon-outline',
    lines: [
      'Each week brings three goals: no speeding, smooth driving and clean drives. They’re just for fun and never change your scores.',
      'Badges mark milestones: First Drive, Clean 100 and Perfect Week.',
    ],
  },
  {
    id: 'friends',
    title: 'Friends',
    icon: 'people-outline',
    lines: [
      'The Friends tab ranks you and your friends by Safety Rating.',
      'Friends see your Safety Rating. Your category scores, badges, driving stats and heat map stay private until you share them in Settings › Privacy.',
    ],
  },
  {
    id: 'mistakes',
    title: 'If we got it wrong',
    icon: 'flag-outline',
    lines: [
      'Every event on a drive has a Report link.',
      `“Braked for a hazard”, “wrong speed limit” and “phone was mounted” are accepted right away, up to ${DISPUTE_AUTO_PER_WEEK} times a week.`,
      `“DashPal got it wrong” is accepted right away too, up to ${CAMERA_DISPUTE_AUTO_PER_WEEK} times a week, on top of those.`,
      `“Wasn’t driving” takes a whole drive off when someone else drove. You can use it ${NOT_DRIVING_PER_MONTH} times a month, within a day of the drive, as long as “${ND}” didn’t run out during it.`,
      'Recorded drives can’t be deleted, so nobody can hide a rough drive.',
    ],
  },
];
