/**
 * The permission words: Home's one row, the "Don't remind me again" confirmation, and
 * Settings › Permissions. On an iPhone the words speak of drives starting on their own; on Android,
 * of drives started from Home. Each line says only what the reading supports and what it means for a
 * drive; nothing nags. Limits, pinned by tests: Home lines ≤ 60 characters, Settings details ≤ 100.
 */
import { IDLE_END_S } from '@scoring';

import type { PermissionPlatform } from '@/core/permissions';

import { ANDROID_NEARBY_DEVICES_API, type MissingState, type PermissionId, type PermState } from './registry';

/** Who is reading: the platform names differ, and Android 11 and lower have no Bluetooth permission. */
export interface CopyCtx {
  platform: PermissionPlatform;
  androidApi: number | null;
}

const IDLE_MIN = Math.round(IDLE_END_S / 60);

export const HOME_LINE_MAX = 60;
export const DETAIL_MAX = 100;

export const permissionsCopy = {
  title: 'Permissions',
  loading: 'Checking this phone',
  readError: "Couldn't check this phone's permissions.",
  retry: 'Try again',
  actionError: "That didn't work. Try again.",
  summary: {
    ok: 'Everything RoadWise needs is on',
    attention: 'A few things need a look',
    broken: "RoadWise can't record drives right now",
  },
  /** The note under the list. */
  about: {
    ios: "With Location set to Always, RoadWise notices drives and records them even when it's closed. Your location is never sold.",
    android: 'A drive uses location only while it records. Start each drive from Home.',
  },
  /** The second note: how phone pickups are noticed, which needs no permission. */
  phone: 'On a drive, RoadWise can tell from motion alone when you pick up your phone. It never sees your screen, apps or messages.',
  status: { on: 'On', notYet: 'Needs a look', off: 'Off', idle: 'Not in use', unknown: "Can't check" },
  openSettings: 'Open Settings',
  hiddenFromHome: 'Hidden from Home',
  /** A Settings row's detail for Location Always or Background App Refresh while the Automatic drives switch is off. */
  autoOff: 'Only needed for automatic drives, and those are turned off.',
  showOnHome: 'Show on Home',
  home: {
    allow: 'Allow',
    openSettings: 'Open Settings',
    more: (n: number) => `${n} more`,
    seeAll: 'See all',
    moreLabel: (n: number) => (n === 1 ? '1 more permission needs a look. See all.' : `${n} more permissions need a look. See all.`),
    swipe: "Don't remind me",
    dismissAction: "Don't remind me again",
    confirmTitle: "Don't remind me again?",
    confirmMessage: (name: string) => `Home won't remind you about ${name} again. You can undo this in Profile › Settings › Permissions.`,
    cancel: 'Cancel',
    confirm: "Don't remind me",
  },
};

export type StatusWord = keyof typeof permissionsCopy.status;

/** The status word of a Settings row (glyph and word, never colour alone). */
export function statusWord(state: PermState): StatusWord {
  switch (state.kind) {
    case 'granted':
      return 'on';
    case 'missing':
      return state.reason === 'notYet' ? 'notYet' : 'off';
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'unknown';
  }
}

const nearbyDevices = (c: CopyCtx) => c.platform === 'android' && (c.androidApi ?? ANDROID_NEARBY_DEVICES_API) >= ANDROID_NEARBY_DEVICES_API;
const motionName = (c: CopyCtx) => (c.platform === 'ios' ? 'Motion & Fitness' : 'Physical activity');

/** A Settings row's title. */
export function rowTitle(id: PermissionId, c: CopyCtx): string {
  switch (id) {
    case 'location':
      return 'Location while using';
    case 'precise':
      return 'Precise location';
    case 'motion':
      return motionName(c);
    case 'locationAlways':
      return 'Location Always';
    case 'backgroundRefresh':
      return 'Background App Refresh';
    case 'notifications':
      return 'Notifications';
    case 'bluetooth':
      return nearbyDevices(c) ? 'Nearby devices' : 'Bluetooth';
    case 'camera':
      return 'Camera';
  }
}

/** The name the "Don't remind me again" confirmation uses. */
export function permissionName(id: PermissionId, c: CopyCtx): string {
  switch (id) {
    case 'location':
      return 'Location';
    case 'precise':
      return 'Precise Location';
    default:
      return rowTitle(id, c);
  }
}

/** Home's one line for a missing permission (≤ 60 characters). */
export function homeLine(id: PermissionId, state: MissingState, c: CopyCtx): string {
  const ios = c.platform === 'ios';
  switch (id) {
    case 'location':
      if (state.reason === 'servicesOff') return ios ? 'Location Services are off. Turn on in Privacy & Security.' : "Location Services are off. Drives can't record.";
      return state.reason === 'notYet' ? 'Allow Location so drives can record.' : "Location is off. Drives can't record.";
    case 'precise':
      return "Precise Location is off. Drives can't record.";
    case 'locationAlways':
      return 'Set Location to Always so drives start on their own.';
    case 'motion':
      if (ios) return state.reason === 'notYet' ? 'Allow Motion & Fitness so RoadWise can spot drives.' : "Motion & Fitness is off. Drives won't start on their own.";
      return state.reason === 'notYet' ? `Allow ${motionName(c)} so walking away ends a drive.` : `${motionName(c)} is off. Walking away won't end a drive.`;
    case 'backgroundRefresh':
      return 'Turn on Background App Refresh to catch every drive.';
    case 'notifications':
      return state.reason === 'notYet' ? 'Allow Notifications to get your drive recaps.' : "Notifications are off. You'll miss your drive recaps.";
    case 'bluetooth':
      return nearbyDevices(c) ? "Nearby devices isn't allowed. DashPal can't connect." : "Bluetooth isn't allowed. DashPal can't connect.";
    case 'camera':
      return "Camera access is off, so you can't scan QR codes.";
  }
}

const CANT_CHECK = "RoadWise couldn't check this on this phone.";

/** One line under a Settings row's title: what this state means (≤ 100 characters). */
export function rowDetail(id: PermissionId, state: PermState, c: CopyCtx): string {
  if (state.kind === 'unknown') return CANT_CHECK;
  const on = state.kind === 'granted';
  const ios = c.platform === 'ios';
  switch (id) {
    case 'location':
      if (state.kind === 'missing' && state.reason === 'servicesOff') {
        return ios ? 'Location Services are off. Turn them on in Settings › Privacy & Security › Location Services.' : "Location Services are off, so drives can't record.";
      }
      return on ? 'RoadWise can measure speed and miles on your drives.' : "Without it, RoadWise can't record drives.";
    case 'precise':
      return on ? 'Speed and distance are measured accurately.' : 'Approximate location is too rough to record a drive.';
    case 'locationAlways':
      if (state.kind === 'idle') return 'Allow Location first.';
      return on ? 'RoadWise can notice your drives and record them with the app closed.' : "Drives won't start on their own. You can still start them from Home.";
    case 'motion': {
      if (ios) {
        if (on) return 'RoadWise can tell driving from walking, so drives start and end on time.';
        return state.kind === 'missing' && state.reason === 'denied'
          ? "Drives won't start on their own. Also check Privacy & Security › Motion & Fitness."
          : "Without it, drives won't start on their own.";
      }
      return on ? 'If you forget to end a drive, it ends when you walk away.' : `Without it, a drive you forget to end stops after ${IDLE_MIN} min.`;
    }
    case 'backgroundRefresh':
      return on ? 'iOS can wake RoadWise when a drive starts.' : "iOS can't wake RoadWise, so drives won't start on their own.";
    case 'notifications':
      return on ? 'Drive recaps, your weekly recap and friend requests can reach you.' : "You won't get drive recaps, your weekly recap or friend requests.";
    case 'bluetooth':
      if (state.kind === 'idle') return nearbyDevices(c) || ios ? 'Used only with a paired DashPal.' : 'Uses Location on this phone.';
      return on ? 'Your DashPal can connect.' : "Your DashPal can't connect, so it plays its alerts itself.";
    case 'camera':
      if (state.kind === 'idle') return 'RoadWise asks when you scan a QR code.';
      return on ? 'You can scan friend QR codes.' : "QR codes can't be scanned. Add friends by username.";
  }
}

/** The Settings button that asks the phone (only where a row can ask). */
export function requestLabel(id: PermissionId, state: MissingState): string {
  switch (id) {
    case 'location':
      return state.reason === 'servicesOff' ? 'Turn on location' : 'Allow location';
    case 'precise':
      return 'Allow precise location';
    case 'locationAlways':
      return 'Allow Always';
    case 'motion':
      return 'Allow motion';
    case 'notifications':
      return 'Allow notifications';
    default:
      return permissionsCopy.openSettings;
  }
}
