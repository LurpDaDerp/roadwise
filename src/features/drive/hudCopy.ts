import type { EventType } from '@scoring';
import type { Href } from 'expo-router';

import { spotsCopy } from '@/features/spots/copy';

/**
 * The words on the driving screen. Anything a driver may see while moving is one to three words
 * (spec "Driving screen"); a place heads-up (a spot's nudge) may take four. Spoken-only strings
 * (screen-reader labels and hints) may be full sentences: they are heard, not read. The waiting
 * band and its panels show only while a Start-card drive, recording from the tap, has not yet
 * reached driving speed.
 */
export const hudCopy = {
  end: 'End drive',
  ending: 'Saving',
  endLabel: 'End drive',
  endHint: 'Swipe right to end the drive.',
  /**
   * End while greyed out for speed, in the driver's units: it locks at 20 mph but only comes back
   * under 10 (16 km/h is about 10 mph), so the hint names the speed where it comes back.
   */
  endLockedHint: (units: 'mi' | 'km') => (units === 'km' ? 'Available below 16 km/h.' : 'Available below 10 mph.'),
  /** After End failed: two words while moving; the full sentence is spoken. */
  endFailed: 'Swipe again',
  endFailedLabel: "Couldn't end the drive. Swipe End again.",
  /** End while a Start-card drive still waits for driving speed: it ends the drive unsaved. */
  cancel: 'Cancel',
  cancelLabel: 'Cancel',
  cancelHint: 'Swipe right to stop waiting. Nothing is saved.',
  /** The small link that discards the drive while it is still offered (also on the Live Activity). */
  notDriving: 'Not driving?',
  notDrivingLabel: 'Not driving? Stop this drive',
  notDrivingHint: "Stops recording. This trip won't count.",
  /** The band while a Start-card drive still waits for driving speed. */
  waiting: {
    title: 'Ready to roll',
    line: 'Saved once you drive',
    spoken: "Ready to roll. Recording now; the drive is saved once you're driving.",
  },
  /** The panel at 2:00 of waiting. */
  ask: {
    title: 'Still planning to drive?',
    body: (min: number) => `We'll stop waiting in ${min} min.`,
    keep: 'Keep waiting',
    cancel: 'Cancel',
  },
  /** The panel's last 30 s. */
  countdown: {
    title: 'Stopping in',
    body: 'Touch the screen to keep waiting.',
    spoken: (s: number) => `Stopping in ${s} seconds. Touch the screen to keep waiting.`,
  },
  /** A problem spot's nudge, one per kind (four words at most; the spot sheet quotes the same line). */
  spot: spotsCopy.nudge,
  /**
   * The alert chip at the top, one per event type: what to do now. Speeding's says "Slow down" as
   * the car passes the speeding line (the recap, history and analytics still name the event
   * "Speeding").
   */
  alert: {
    speeding: 'Slow down',
    hard_brake: 'Hard brake',
    hard_accel: 'Hard start',
    hard_corner: 'Sharp turn',
    phone_pickup: 'Phone down',
    eyes_off: 'Eyes up',
    drowsy: 'Take a break',
  } satisfies Record<EventType, string>,
  /** The strip on other screens while a drive records, or while a Start drive swipe waits. */
  banner: {
    title: 'Drive in progress',
    action: 'Back to drive',
    label: 'Drive in progress. Go back to the driving screen.',
    waitingTitle: 'Ready to roll',
    waitingAction: 'Open',
    waitingLabel: 'Waiting for you to drive. Go back to the driving screen.',
  },
} as const;

/** The driving screen's route as `usePathname()` reports it. */
export const DRIVE_SCREEN = '/drive';
export const DRIVE_HREF: Href = '/drive';
