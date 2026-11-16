// What the drive host asks of the phone for "Are you driving?" (iPhone with the car link): the
// Bluetooth radio (read without ever prompting, `carRadioState`), the notification permission (read,
// never asked), and the note itself, posted at once with no sound and taken down by its identifier.
// Every native module is loaded only when first used.
import type { RadioState } from '@/core/permissions/adapters';
import { carRadioState } from '@/core/permissions/carBluetooth';
import { createSettingsRepo, type Db } from '@/data/db';
import { carCopy } from '@/features/carLink/copy';
import { PASSENGER_CHECK_KIND, passengerCheckId } from '@/features/notifications/passengerCheck';

export interface PassengerNotePort {
  /** The Bluetooth radio's state, or null when it cannot be read without a prompt (never creates one that prompts). */
  bluetooth(): Promise<RadioState | null>;
  /** Notifications may show (granted or provisional). Read only. */
  notificationsAllowed(): Promise<boolean>;
  post(clientTripId: string): Promise<void>;
  /** Takes the drive's note down (pending or delivered); a note never posted is no error. */
  remove(clientTripId: string): Promise<void>;
}

type NotificationsModule = typeof import('expo-notifications');

// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
const notifications = (): NotificationsModule => require('expo-notifications') as NotificationsModule;
type ChannelsModule = typeof import('@/features/notifications/channels');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: it loads expo-notifications
const channels = (): ChannelsModule => require('@/features/notifications/channels') as ChannelsModule;

export function createPassengerNotePort(db: Db): PassengerNotePort {
  return {
    async bluetooth() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the BLE native module
      const { lazyBluetooth } = require('@/core/permissions/adapters') as typeof import('@/core/permissions/adapters');
      return carRadioState({ platform: 'ios', settings: createSettingsRepo(db), radio: lazyBluetooth });
    },
    async notificationsAllowed() {
      const n = notifications();
      const p = await n.getPermissionsAsync();
      return p.granted || p.ios?.status === n.IosAuthorizationStatus.PROVISIONAL;
    },
    async post(clientTripId) {
      // Android: on its own silent channel (made first; a no-op on iOS).
      const { DRIVE_ALERTS_CHANNEL_ID, ensureAndroidChannels } = channels();
      await ensureAndroidChannels();
      await notifications().scheduleNotificationAsync({
        identifier: passengerCheckId(clientTripId),
        content: {
          title: carCopy.passenger.title,
          body: carCopy.passenger.body,
          data: { kind: PASSENGER_CHECK_KIND, clientTripId },
          sound: false,
        },
        // Android reads the channel only from the trigger (with none the note lands on expo's
        // fallback channel, which sounds); a channel-only trigger still posts at once, and on iOS it
        // is the same as no trigger.
        trigger: { channelId: DRIVE_ALERTS_CHANNEL_ID },
      });
    },
    async remove(clientTripId) {
      const n = notifications();
      const id = passengerCheckId(clientTripId);
      await n.cancelScheduledNotificationAsync(id).catch(() => {});
      await n.dismissNotificationAsync(id).catch(() => {});
    },
  };
}
