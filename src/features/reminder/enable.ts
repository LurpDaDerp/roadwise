/**
 * Switching the optional forgot-to-start reminder (off by default). The reminder itself is native
 * (drive-sense) and only ever posts a notification that opens Home; nothing here, or there, starts
 * a drive. Turning it on is the driver's tap, and that tap is the only moment it asks the phone
 * for anything: motion, notifications, and on iOS While Using then "Always" (asked once).
 */
import DriveSense, { type DriveSenseApi, type TripReminderStatus } from '@drive-sense';

import type { NotificationAccess, PermissionsAdapter } from '@/core/permissions';

export type ReminderNative = Pick<DriveSenseApi, 'setTripReminder' | 'getTripReminderStatus'>;

/** The native module (rejects where it is absent: Jest, Expo Go, web). */
export const nativeReminder: ReminderNative = DriveSense;

const fullyAllowed = (n: NotificationAccess) => n === 'granted';

/**
 * Asks for what the reminder still needs, then turns it on. It is saved on even when something
 * stays missing; the returned status says what (Settings shows it, and never asks again by itself).
 */
export async function turnOnReminder(adapter: PermissionsAdapter, native: ReminderNative = nativeReminder): Promise<TripReminderStatus> {
  try {
    const snap = await adapter.snapshot();
    if (snap.motion === 'undetermined') await adapter.requestMotion().catch(() => null);
    if (!fullyAllowed(snap.notifications) && snap.notificationsCanAskAgain) await adapter.requestNotifications().catch(() => null);
    if (snap.platform === 'ios') {
      let location = snap.location;
      if (location === 'undetermined') {
        await adapter.requestLocationForeground().catch(() => null);
        location = (await adapter.snapshot()).location;
      }
      if (location === 'foreground') await adapter.requestAlwaysForReminder().catch(() => null);
    }
  } catch {
    // A read that failed asks nothing more; the status below still says what is missing.
  }
  return native.setTripReminder(true);
}

/** "Resume now" on a paused reminder: the pause and the quiet end. Asks the phone for nothing. */
export function resumeReminder(native: ReminderNative = nativeReminder): Promise<TripReminderStatus> {
  return native.setTripReminder(true);
}

/** Off: everything the reminder kept is forgotten and its wake stops. Settings, sign-out and the device wipe. */
export function turnOffReminder(native: ReminderNative = nativeReminder): Promise<TripReminderStatus> {
  return native.setTripReminder(false);
}

export function readReminderStatus(native: ReminderNative = nativeReminder): Promise<TripReminderStatus> {
  return native.getTripReminderStatus();
}
