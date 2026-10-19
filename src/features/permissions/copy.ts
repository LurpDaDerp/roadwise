/**
 * The permission words: Home's one row, the "Don't remind me again" confirmation, and
 * Settings › Permissions. Each line says only what the reading supports and what it means for a
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
    attention: 'A couple of things could be better',
    broken: "RoadWise can't record drives right now",
  },
  never:
    'A drive uses location only while it records. Location “Always” is asked for only on iPhone, and only if you turn on the forgot-to-start reminder.',
  status: { on: 'On', notYet: 'Needs a look', off: 'Off', idle: 'Not in use', unknown: "Can't check" },
  openSettings: 'Open Settings',
  hiddenFromHome: 'Hidden from Home',
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
    confirmMessage: (name: string) => `Home won't remind you about ${name} again. You can turn this back on in Profile › Settings › Permissions.`,
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
    case 'notifications':
      return 'Notifications';
    case 'reminderAccess':
      return c.platform === 'ios' ? 'Location Always' : 'Drive reminder notifications';
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
    case 'reminderAccess':
      return c.platform === 'ios' ? 'Location Always' : 'Drive reminder notifications';
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
    case 'motion':
      return state.reason === 'notYet' ? `Allow ${motionName(c)} so walking away ends a drive.` : `${motionName(c)} is off. Walking away won't end a drive.`;
    case 'notifications':
      return state.reason === 'notYet' ? 'Allow Notifications for reminders and results.' : "Notifications are off. You'll miss reminders and results.";
    case 'reminderAccess':
      return ios ? 'The reminder needs Location set to Always.' : 'Drive reminder notifications are off.';
    case 'bluetooth':
      return nearbyDevices(c) ? "Nearby devices isn't allowed. DashPal can't connect." : "Bluetooth isn't allowed. DashPal can't connect.";
    case 'camera':
      return "The camera isn't allowed. QR codes can't be scanned.";
  }
}

const CANT_CHECK = "RoadWise couldn't check this on this phone.";

/** One line under a Settings row's title: what this state means (≤ 100 characters). */
export function rowDetail(id: PermissionId, state: PermState, c: CopyCtx, opts: { reminderOn?: boolean } = {}): string {
  if (state.kind === 'unknown') return CANT_CHECK;
  const on = state.kind === 'granted';
  const ios = c.platform === 'ios';
  switch (id) {
    case 'location':
      if (state.kind === 'missing' && state.reason === 'servicesOff') {
        return ios ? 'Location Services are off. Turn them on in Settings › Privacy & Security › Location Services.' : "Location Services are off for this phone, so drives can't record.";
      }
      return on ? 'RoadWise can measure speed and miles on your drives.' : "Without it, RoadWise can't record drives.";
    case 'precise':
      return on ? 'Speed and distance are measured accurately.' : 'Approximate location is too rough to record a drive.';
    case 'motion': {
      if (on) return 'A drive you forget to end stops when you walk away, and the reminder can notice a trip.';
      const line = `Without it, a forgotten drive ends after ${IDLE_MIN} min.`;
      return ios && state.kind === 'missing' && state.reason === 'denied' ? `${line} Also check Privacy & Security › Motion & Fitness.` : line;
    }
    case 'notifications':
      return on ? 'Reminders, drive results, your weekly recap and friend requests can reach you.' : "You won't get reminders, drive results or your weekly recap.";
    case 'reminderAccess':
      if (ios) {
        if (on) return 'The forgot-to-start reminder can notice a drive with RoadWise closed.';
        if (state.kind === 'missing') return 'The reminder needs Location set to Always.';
        return opts.reminderOn ? 'Allow Location first; the reminder then needs it set to Always.' : 'Only for the forgot-to-start reminder, which is off.';
      }
      if (state.kind === 'idle') {
        return opts.reminderOn ? 'Turn on Notifications first; the reminder then shows its note.' : 'Only for the forgot-to-start reminder, which is off.';
      }
      return on ? 'Drive reminder notifications can appear.' : "The forgot-to-start reminder can't show its note.";
    case 'bluetooth':
      if (state.kind === 'idle') return nearbyDevices(c) || ios ? 'Used only with a paired DashPal.' : 'Uses Location on this phone.';
      return on ? 'Your DashPal can connect.' : "Your DashPal can't connect, so its alerts stay on its own buzzer.";
    case 'camera':
      if (state.kind === 'idle') return 'Asked when you scan a QR code.';
      return on ? 'You can scan QR codes: friend codes.' : "QR codes can't be scanned. Add friends by username.";
  }
}

/** The Settings button that asks the phone (only where a row can ask). */
export function requestLabel(id: PermissionId, state: MissingState): string {
  switch (id) {
    case 'location':
      return state.reason === 'servicesOff' ? 'Turn on location' : 'Allow location';
    case 'precise':
      return 'Allow precise location';
    case 'motion':
      return 'Allow motion';
    case 'notifications':
      return 'Allow notifications';
    default:
      return permissionsCopy.openSettings;
  }
}
