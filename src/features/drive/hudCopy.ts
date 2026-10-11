import type { EventType } from '@scoring';
import type { Href } from 'expo-router';

/**
 * The words on the driving screen. Anything a driver may see while moving is one or two words
 * (spec "Driving screen"; never more than three). Spoken-only strings (screen-reader labels and
 * hints) may be full sentences: they are heard, not read.
 */
export const hudCopy = {
  end: 'End',
  ending: 'Saving',
  endLabel: 'End drive',
  endHint: 'Touch and hold to end the drive.',
  /** After End failed: two words while moving; the full sentence is spoken. */
  endFailed: 'Hold again',
  endFailedLabel: "Couldn't end the drive. Hold End again.",
  /** The alert chip at the top, one per event type. */
  alert: {
    speeding: 'Speeding',
    hard_brake: 'Hard brake',
    hard_accel: 'Hard start',
    hard_corner: 'Sharp turn',
    phone_pickup: 'Phone',
    phone_handling: 'Phone',
    eyes_off: 'Eyes up',
    drowsy: 'Take a break',
  } satisfies Record<EventType, string>,
  weatherLabel: (words: string) => `Weather alert: ${words}`,
  points: {
    unit: 'pts',
    label: (total: string, change: string) => `${total} points, ${change} since your last stop`,
  },
  banner: {
    title: 'Drive in progress',
    action: 'Back to drive',
    label: 'Drive in progress. Go back to the driving screen.',
  },
} as const;

/** The driving screen's route as `usePathname()` reports it. */
export const DRIVE_SCREEN = '/drive';
export const DRIVE_HREF: Href = '/drive';
