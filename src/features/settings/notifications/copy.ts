/**
 * H6's own words. Each switch's hint says what that setting does in either position, and only what
 * the app actually does: the inbox mirrors every notification (§11.1 rule 4), push-sender and the
 * local plan both hold what falls in quiet hours to the quiet end, and the promise about recording
 * is shown only while this phone reports its drive state (the screen checks).
 */
import type { NotificationCategory } from '@/notifications/catalog';

export interface CategoryCopy {
  title: string;
  on: string;
  off: string;
}

export const notificationSettingsCopy = {
  title: 'Notifications',
  back: 'Back',
  /** Shown only while `useDriveStateReported()` is true. */
  promise: "Nothing from RoadWise arrives while you're recording a drive.",
  sendLabel: 'Send me',
  /** Only categories with a live type are shown; the rest arrive with their milestones. */
  categories: {
    trip_summaries: {
      title: 'Drive summaries',
      on: 'A notification a couple of minutes after a drive ends.',
      off: 'No notification after a drive. Your drives are still saved in your history.',
    },
    recording: {
      title: 'Recording problems',
      on: 'A notification if a phone setting stops RoadWise recording or detecting your drives.',
      off: 'No notification. Recording problems still appear in your inbox.',
    },
  } as Partial<Record<NotificationCategory, CategoryCopy>>,
  /** Shown while a switched-on category counts toward §11.1's daily cap. */
  cap: 'At most 2 of these a day, counted together.',
  quiet: {
    label: 'Quiet hours',
    title: 'Quiet hours',
    on: (start: string, end: string) =>
      `Notifications due between ${start} and ${end} wait until ${end}.`,
    off: 'Notifications can arrive at any hour.',
    starts: 'Starts',
    ends: 'Ends',
    earlier: (what: string) => `${what} earlier`,
    later: (what: string) => `${what} later`,
    same: 'Start and end are the same, so quiet hours are off.',
    zone: (zone: string) => `Times are in ${zone}.`,
  },
  os: {
    denied: "Notifications are off for RoadWise in your phone's settings, so none of these can arrive.",
    openSettings: 'Open settings',
    undetermined: "RoadWise hasn't asked to send notifications on this phone yet.",
    allow: 'Allow',
  },
  loadError: "We couldn't load your notification settings.",
  saveError: "That didn't save. Try again.",
  retry: 'Try again',
  saving: 'Saving',
} as const;
