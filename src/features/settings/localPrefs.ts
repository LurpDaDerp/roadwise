/**
 * The device-local settings this area writes (plan §10): the units mirror (`units`, for offline
 * display) and the forgot-to-start reminder (`reminder.forgotToStart`, off by default), which is
 * also handed to the native module when this build has it.
 */
import DriveSense from '@drive-sense';

import type { PermissionSnapshot, PermissionsAdapter } from '@/core/permissions';
import type { SettingsRepo } from '@/data/db/settings';

export const UNITS_KEY = 'units';
export const REMINDER_KEY = 'reminder.forgotToStart';

export type Units = 'mi' | 'km';

export async function readUnits(settings: Pick<SettingsRepo, 'get'>): Promise<Units> {
  return (await settings.get<unknown>(UNITS_KEY)) === 'km' ? 'km' : 'mi';
}

export async function writeUnits(settings: Pick<SettingsRepo, 'set'>, units: Units): Promise<void> {
  await settings.set(UNITS_KEY, units);
}

export async function readReminder(settings: Pick<SettingsRepo, 'get'>): Promise<boolean> {
  return (await settings.get<unknown>(REMINDER_KEY)) === true;
}

type NativeReminder = (enabled: boolean) => Promise<unknown> | unknown;

/**
 * The native setter: WP6's `applyForgotToStartSetting` (src/drive/forgottenDrive) when this build
 * has it, else drive-sense's own `setForgotToStartReminder`. Looked up at call time and guarded, so
 * a build without either simply stores the choice.
 */
function nativeReminder(): NativeReminder | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional sibling module
    const mod = require('@/drive/forgottenDrive') as { applyForgotToStartSetting?: unknown };
    if (typeof mod.applyForgotToStartSetting === 'function') return mod.applyForgotToStartSetting as NativeReminder;
  } catch {
    // Not in this build.
  }
  const fn = (DriveSense as unknown as Record<string, unknown>).setForgotToStartReminder;
  return typeof fn === 'function' ? (fn.bind(DriveSense) as NativeReminder) : null;
}

/** What the reminder needs from the phone: motion everywhere, notifications on Android. */
export type ReminderNeed = 'motion' | 'notifications';

/**
 * Before turning the reminder on: ask for what it needs (each an OS prompt on the driver's tap, only
 * when the phone can still ask) and say what is still missing. An empty list means it can work.
 */
export async function ensureReminderPermissions(adapter: Pick<PermissionsAdapter, 'snapshot' | 'requestMotion' | 'requestNotifications'>): Promise<ReminderNeed[]> {
  const missing: ReminderNeed[] = [];
  let snap: PermissionSnapshot;
  try {
    snap = await adapter.snapshot();
  } catch {
    return ['motion'];
  }
  if (snap.motion !== 'granted') {
    const answer = snap.motion === 'undetermined' ? await adapter.requestMotion().catch(() => null) : snap.motion;
    if (answer !== 'granted') missing.push('motion');
  }
  if (snap.platform === 'android') {
    const allowed = (a: string) => a === 'granted' || a === 'provisional';
    let n: string = snap.notifications;
    if (!allowed(n) && snap.notificationsCanAskAgain) n = await adapter.requestNotifications().catch(() => 'denied');
    if (!allowed(n)) missing.push('notifications');
  }
  return missing;
}

/**
 * Saves the switch, then tells the native side. A native failure (no module in this build, Jest,
 * Expo Go) is swallowed: the stored choice is what the next launch hands over.
 */
export async function writeReminder(
  settings: Pick<SettingsRepo, 'set'>,
  enabled: boolean,
  native: NativeReminder | null = nativeReminder()
): Promise<void> {
  await settings.set(REMINDER_KEY, enabled);
  if (!native) return;
  try {
    await native(enabled);
  } catch {
    // No native module here; the setting is still saved.
  }
}
