/**
 * The "Were you driving?" action category, and the one setup call every scheduler awaits.
 *
 * The role-unknown drive summary (`renderLocal` → `categoryId: 'trip_role'`) carries two buttons,
 * "I drove" and "Passenger". Both open the app: the answer is written by `handleResponse` in the
 * app's own process, through the same `setTripRole` the summary's chips use.
 *
 * A category must exist before a notification naming it is scheduled, or the OS shows it without
 * buttons. `NotificationsHost` calls `ensureNotificationSetup()` at mount, and M3's summary notifier
 * (after Task 19) awaits it before each schedule — memoised, so that costs one native round trip
 * per process.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { ChosenRole } from '@/features/trips/roleActions';

import { ensureAndroidChannels, type ChannelsApi } from './channels';
import { notificationCopy } from './copy';

export const TRIP_ROLE_CATEGORY = 'trip_role';

/** Action identifier → the role `trips.role` stores. */
export const ROLE_ACTIONS = { drove: 'driver', passenger: 'passenger' } as const satisfies Record<
  string,
  ChosenRole
>;
export type RoleActionId = keyof typeof ROLE_ACTIONS;

export type CategoriesApi = Pick<typeof Notifications, 'setNotificationCategoryAsync'>;
export type SetupApi = ChannelsApi & CategoriesApi;

export async function registerCategories(n: CategoriesApi = Notifications): Promise<void> {
  await n.setNotificationCategoryAsync(TRIP_ROLE_CATEGORY, [
    {
      identifier: 'drove',
      buttonTitle: notificationCopy.actions.drove,
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'passenger',
      buttonTitle: notificationCopy.actions.passenger,
      options: { opensAppToForeground: true },
    },
  ]);
}

const setups = new WeakMap<object, Promise<void>>();

/** Channels, then categories. Memoised per process; a failure is retried by the next caller. */
export function ensureNotificationSetup(
  n: SetupApi = Notifications,
  os: string = Platform.OS
): Promise<void> {
  const existing = setups.get(n);
  if (existing) return existing;
  const run = (async () => {
    await ensureAndroidChannels(n, os);
    await registerCategories(n);
  })();
  setups.set(n, run);
  run.catch(() => {
    if (setups.get(n) === run) setups.delete(n);
  });
  return run;
}
