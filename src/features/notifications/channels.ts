/**
 * The Android notification channels this app posts to.
 *
 * Two: `trips` (the local drive summary) and `updates` (the pushes the server sends: weekly recap
 * and friend requests; `ANDROID_CHANNEL` in supabase/functions/_shared/push_copy.ts).
 * The native foreground-service channel is created and owned by the native module; nothing here
 * touches it.
 *
 * Callable before `NotificationsHost` mounts: onboarding (A8) creates the channels before the
 * Android 13+ notification prompt, so the system settings name them from the first moment.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { notificationCopy } from './copy';

export type ChannelsApi = Pick<typeof Notifications, 'setNotificationChannelAsync' | 'AndroidImportance'>;

export interface DeviceChannel {
  id: 'trips' | 'updates';
  name: string;
}

export const DEVICE_CHANNELS: readonly DeviceChannel[] = [
  { id: 'trips', name: notificationCopy.channels.trips },
  { id: 'updates', name: notificationCopy.channels.updates },
];

/** One settled creation per API object; a failure is forgotten so the next caller retries. */
const created = new WeakMap<object, Promise<void>>();

/** Idempotent. A no-op off Android. */
export function ensureAndroidChannels(
  n: ChannelsApi = Notifications,
  os: string = Platform.OS
): Promise<void> {
  if (os !== 'android') return Promise.resolve();
  const existing = created.get(n);
  if (existing) return existing;
  const run = (async () => {
    for (const channel of DEVICE_CHANNELS) {
      await n.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        importance: n.AndroidImportance.DEFAULT,
      });
    }
  })();
  created.set(n, run);
  run.catch(() => {
    if (created.get(n) === run) created.delete(n);
  });
  return run;
}
