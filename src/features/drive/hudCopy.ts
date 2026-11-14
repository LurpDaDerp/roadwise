import type { EventType } from '@scoring';
import type { Href } from 'expo-router';

import { EMERGENCY_NUMBER } from '@/features/emergency/model';
import { spotsCopy } from '@/features/spots/copy';
import { t } from '@/i18n';

/**
 * The words on the driving screen. Anything a driver may see while moving is one to three words
 * (spec "Driving screen"); a place heads-up (a spot's nudge) and the break reminder may take four. Spoken-only strings
 * (screen-reader labels and hints) may be full sentences: they are heard, not read. The waiting
 * panels show only while a Start-card drive, recording from the tap, has not yet reached driving
 * speed.
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
   * The break reminder at a stop after 2 h of driving (the words it speaks too): four words, the one
   * spoken line over three (`alert.takeABreak`).
   */
  breakReminder: t('alert.takeABreak'),
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
  /**
   * The driving screen's error boundary: the screen threw while drawing. Three words and two while
   * moving; the spoken label says the drive itself is untouched.
   */
  crashed: {
    title: 'Something went wrong',
    retry: 'Try again',
    spoken: "The driving screen hit a problem. If you're on a drive, it's still recording.",
    retryHint: 'Reloads the driving screen.',
  },
  /**
   * The emergency button and its panel: 911 first, then the driver's contacts. A tap on a row hands
   * the number to the phone's own call screen.
   */
  sos: {
    label: 'Emergency call',
    hint: 'Opens 911 and your emergency contacts.',
    title: 'Emergency call',
    call911: `Call ${EMERGENCY_NUMBER}`,
    call911Hint: `Calls ${EMERGENCY_NUMBER}.`,
    contactLabel: (name: string, number: string) => `Call ${name}, ${number}`,
    none: 'Add contacts in Settings.',
    close: 'Close',
    closeHint: 'Closes the emergency panel.',
    failed: "Call didn't start",
  },
  /** The line over the darkened screen as a drive ends at a saved place (the car stopped there). */
  arrival: {
    home: 'Welcome home',
    work: 'Welcome to work',
    school: 'Welcome to school',
    custom: (name: string) => `Welcome to ${name}`,
  },
} as const;

/** The driving screen's route as `usePathname()` reports it. */
export const DRIVE_SCREEN = '/drive';
export const DRIVE_HREF: Href = '/drive';
