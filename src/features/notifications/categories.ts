/**
 * The one setup call every scheduler awaits: the Android channels, and the one notification
 * category RoadWise has: an automatic drive's recap (`PASSENGER_CATEGORY_ID`) with one action,
 * "I wasn't driving", which opens the app (`NotificationsHost` handles it). Every other
 * notification carries no action button (a manual drive's recap opens the app; the pushes open
 * their screen).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { ensureAndroidChannels, type ChannelsApi } from './channels';
import { PASSENGER_ACTION_ID, PASSENGER_CATEGORY_ID, passengerCopy } from './passenger';

export type SetupApi = ChannelsApi & Partial<Pick<typeof Notifications, 'setNotificationCategoryAsync'>>;

const setups = new WeakMap<object, Promise<void>>();

/** The recap's category: its one action opens the app, unlocked first. */
export async function ensurePassengerCategory(n: SetupApi = Notifications, os: string = Platform.OS): Promise<void> {
  if (os === 'web' || typeof n.setNotificationCategoryAsync !== 'function') return;
  await n.setNotificationCategoryAsync(PASSENGER_CATEGORY_ID, [
    { identifier: PASSENGER_ACTION_ID, buttonTitle: passengerCopy.action, options: { opensAppToForeground: true } },
  ]);
}

/** Memoised per process; a failure is retried by the next caller. */
export function ensureNotificationSetup(n: SetupApi = Notifications, os: string = Platform.OS): Promise<void> {
  const existing = setups.get(n);
  if (existing) return existing;
  const run = Promise.all([ensureAndroidChannels(n, os), ensurePassengerCategory(n, os)]).then(() => undefined);
  setups.set(n, run);
  run.catch(() => {
    if (setups.get(n) === run) setups.delete(n);
  });
  return run;
}
