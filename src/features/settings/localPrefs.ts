/**
 * The device-local settings this area writes (plan §10): the units mirror (`units`, for offline
 * display) and the forgot-to-start reminder (`reminder.forgotToStart`, off by default), which is
 * also handed to the native module when this build has it.
 */
import DriveSense from '@drive-sense';

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

/** The native setter, when this build's drive-sense module has one (WP7 adds it). */
function nativeReminder(): NativeReminder | null {
  const fn = (DriveSense as unknown as Record<string, unknown>).setForgotToStartReminder;
  return typeof fn === 'function' ? (fn.bind(DriveSense) as NativeReminder) : null;
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
