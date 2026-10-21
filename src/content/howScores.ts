/**
 * "How scores work": the three ideas Home and the screen show, and the full rules in plain words.
 * Every number is read from a constant (the scoring package, or the drive rules the screen hands
 * in), so the page can't drift from what the app and the server actually do.
 */
import type { Ionicons } from '@expo/vector-icons';

import { RATING_WINDOW_DAYS } from '@scoring';

export type IconName = keyof typeof Ionicons.glyphMap;

export interface HowItem {
  icon: IconName;
  title: string;
  body: string;
}

/** The three ideas: Home's How it works card and the top of How scores work. */
export const howItWorks = (autoDrives: boolean): HowItem[] => [
  autoDrives
    ? { icon: 'car-sport-outline', title: 'Drives record themselves', body: 'Once you’re on the road, RoadWise starts recording. Riding along? Tap “Not driving?”.' }
    : { icon: 'car-sport-outline', title: 'Start, then drive', body: 'Swipe Start drive before you pull out. RoadWise records until you park.' },
  { icon: 'speedometer-outline', title: 'Every drive gets a score', body: 'Gentle stops, smooth starts, easy turns and staying near the limit all help.' },
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
