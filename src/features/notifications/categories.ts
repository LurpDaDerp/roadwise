/**
 * The one setup call every scheduler awaits: the Android channels. v3 notifications carry no
 * action buttons (the drive summary opens the app; the pushes open their screen), so there is no
 * category to register.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { ensureAndroidChannels, type ChannelsApi } from './channels';

export type SetupApi = ChannelsApi;

const setups = new WeakMap<object, Promise<void>>();

/** Memoised per process; a failure is retried by the next caller. */
export function ensureNotificationSetup(n: SetupApi = Notifications, os: string = Platform.OS): Promise<void> {
  const existing = setups.get(n);
  if (existing) return existing;
  const run = ensureAndroidChannels(n, os);
  setups.set(n, run);
  run.catch(() => {
    if (setups.get(n) === run) setups.delete(n);
  });
  return run;
}
