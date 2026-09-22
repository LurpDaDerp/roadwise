/**
 * The Android notification channels this app posts to.
 *
 * Two, for the two live notification types: `trips` (the local drive summary) and
 * `recording_problems` (a pushed permission lapse). The recording-problems channel is named apart
 * from M3's native `drive_recording` foreground-service channel, which is created and owned by the
 * native module; nothing here touches it.
 *
 * Callable before `NotificationsHost` mounts: onboarding (A8) creates the channels before the
 * Android 13+ notification prompt, so the system settings name them from the first moment.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { AndroidChannel } from '@/notifications/catalog';

import { notificationCopy } from './copy';

export type ChannelsApi = Pick<typeof Notifications, 'setNotificationChannelAsync' | 'AndroidImportance'>;

export interface DeviceChannel {
  id: Extract<AndroidChannel, 'trips' | 'recording_problems'>;
  name: string;
}

export const DEVICE_CHANNELS: readonly DeviceChannel[] = [
  { id: 'trips', name: notificationCopy.channels.trips },
  { id: 'recording_problems', name: notificationCopy.channels.recording_problems },
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
