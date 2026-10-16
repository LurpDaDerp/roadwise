/**
 * What the Settings row says about the forgot-to-start reminder, from its native status. Pure.
 */
import type { TripReminderStatus } from '@drive-sense';

import { reminderCopy } from './copy';

export type ReminderPlatform = 'ios' | 'android';

export interface ReminderLine {
  text: string;
  /** The one button under the line, if any. */
  action: 'openSettings' | null;
  /** The switch cannot be used (no hardware or Play services). */
  disabled: boolean;
}

const L = reminderCopy.lines;

export function reminderLine(status: TripReminderStatus, platform: ReminderPlatform): ReminderLine {
  switch (status.state) {
    case 'unavailable':
      return { text: L.unavailable, action: null, disabled: true };
    case 'off':
      return { text: L.off, action: null, disabled: false };
    case 'on':
      return { text: platform === 'ios' ? L.onIos : L.onAndroid, action: null, disabled: false };
    case 'needs':
      return { text: needsLine(status.missing, platform), action: 'openSettings', disabled: false };
  }
}

function needsLine(missing: TripReminderStatus['missing'], platform: ReminderPlatform): string {
  if (platform === 'android') {
    const what = (['motion', 'notifications'] as const).filter((m) => missing.includes(m)).map((m) => reminderCopy.missingAndroid[m]);
    return L.needsAndroid(what.length > 0 ? what.join(' and ') : reminderCopy.missingAndroid.motion);
  }
  // iOS names the one thing to fix first: Always, then precise, then notifications, then motion.
  if (missing.includes('locationAlways')) return L.needsAlways;
  if (missing.includes('locationPrecise')) return L.needsPrecise;
  if (missing.includes('notifications')) return L.needsIosNotifications;
  return L.needsIosMotion;
}
