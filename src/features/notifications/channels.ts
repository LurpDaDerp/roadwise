/**
 * The Android notification channels this app posts to, set up to present each notification as the
 * iPhone does (no app badge anywhere; silent where iOS is silent):
 *
 * - `recaps`: the local drive recap. HIGH, so it peeks as a heads-up banner the way iOS banners it;
 *   silent (no sound, no vibration), as the iOS recap is.
 * - `pushes`: the pushes the server sends (weekly recap, monthly Wrapped, friend requests;
 *   `ANDROID_CHANNEL` in supabase/functions/_shared/push_copy.ts). DEFAULT, with the default sound,
 *   as the server sends them to iOS with one.
 * - `weather`: the heads-up before the commute. DEFAULT, silent (iOS posts it with no sound).
 * - `drive_alerts`: "Are you driving?". DEFAULT, silent (iOS posts it with no sound).
 *
 * Android fixes a channel's importance, sound and badge once it exists (an app can change only its
 * name and description), so a channel whose presentation changes gets a new id and the old one is
 * deleted (`RETIRED_CHANNEL_IDS`): `trips` (the recap's, DEFAULT with a badge) and `updates` (the
 * pushes', with a badge). Deleting a channel takes its notifications down with it; deleting one
 * that is already gone does nothing. The native module creates and owns its own channels (the drive
 * notification's, the DashPal link's); nothing here touches them.
 *
 * Callable before `NotificationsHost` mounts: onboarding (A8) creates the channels before the
 * Android 13+ notification prompt, so the system settings name them from the first moment.
 * `NotificationsHost` runs it at every launch, so an installed phone moves to the new ids at its
 * first launch of this build.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { notificationCopy } from './copy';

export type ChannelsApi = Pick<typeof Notifications, 'setNotificationChannelAsync' | 'AndroidImportance'> &
  Partial<Pick<typeof Notifications, 'deleteNotificationChannelAsync'>>;

/** The local drive recap's channel (`summaryNotifier.ts`). */
export const RECAP_CHANNEL_ID = 'recaps';
/** The server's pushes' channel: must equal `ANDROID_CHANNEL` in supabase/functions/_shared/push_copy.ts. */
export const PUSH_CHANNEL_ID = 'pushes';
/** The commute weather heads-up's channel (`commuteHeadsUp.ts`). */
export const WEATHER_CHANNEL_ID = 'weather';
/** "Are you driving?"'s channel (`src/drive/passengerNote.ts`). */
export const DRIVE_ALERTS_CHANNEL_ID = 'drive_alerts';

/** Android 8 (API 26) added notification channels; below it a notification's own settings decide its sound. */
export const ANDROID_CHANNELS_API = 26;

/**
 * Whether an Android phone of this API level has notification channels (Android 8 and later). An
 * unreadable level reads as current.
 */
export function androidHasChannels(api: unknown = Platform.Version): boolean {
  const v = typeof api === 'number' ? api : Number(api);
  return !Number.isFinite(v) || v >= ANDROID_CHANNELS_API;
}

/** Channels an earlier build created whose presentation can no longer be changed in place: deleted. */
export const RETIRED_CHANNEL_IDS: readonly string[] = ['trips', 'updates'];

export type DeviceChannelId = typeof RECAP_CHANNEL_ID | typeof PUSH_CHANNEL_ID | typeof WEATHER_CHANNEL_ID | typeof DRIVE_ALERTS_CHANNEL_ID;

export interface DeviceChannel {
  id: DeviceChannelId;
  name: string;
  description: string;
  importance: 'high' | 'default';
  /** No sound and no vibration. */
  silent: boolean;
}

export const DEVICE_CHANNELS: readonly DeviceChannel[] = [
  { id: RECAP_CHANNEL_ID, ...notificationCopy.channels.recaps, importance: 'high', silent: true },
  { id: PUSH_CHANNEL_ID, ...notificationCopy.channels.pushes, importance: 'default', silent: false },
  { id: WEATHER_CHANNEL_ID, ...notificationCopy.channels.weather, importance: 'default', silent: true },
  { id: DRIVE_ALERTS_CHANNEL_ID, ...notificationCopy.channels.driveAlerts, importance: 'default', silent: true },
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
        description: channel.description,
        importance: channel.importance === 'high' ? n.AndroidImportance.HIGH : n.AndroidImportance.DEFAULT,
        showBadge: false,
        // Absent: the default sound; null: none.
        ...(channel.silent ? { sound: null, enableVibrate: false } : {}),
      });
    }
    // The old ids go once the new ones exist. A delete that fails is tried again at the next launch;
    // it never holds up a post (the new channels are already in place).
    for (const id of RETIRED_CHANNEL_IDS) {
      try {
        await n.deleteNotificationChannelAsync?.(id);
      } catch {
        // Kept until the next launch's try.
      }
    }
  })();
  created.set(n, run);
  run.catch(() => {
    if (created.get(n) === run) created.delete(n);
  });
  return run;
}
