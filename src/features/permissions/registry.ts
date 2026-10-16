/**
 * Every permission RoadWise uses, one entry each. Home's permission row and Settings › Permissions
 * are both generated from this table, and the tests iterate it. Each entry turns one read of the
 * phone (`PermissionBoardRead`) into a state. Pure: nothing here touches the OS.
 *
 * Bluetooth and the camera are never requested from here (their `canAsk` is always false): the OS
 * asks for them only where the spec puts them, the DashPal setup and a QR scanner.
 */
import type { TripReminderStatus } from '@drive-sense';

import type { BluetoothPermission, CameraAccess, PermissionPlatform, PermissionSnapshot } from '@/core/permissions';

export type PermissionId = 'location' | 'precise' | 'motion' | 'notifications' | 'reminderAccess' | 'bluetooth' | 'camera';
export type Need = 'required' | 'recommended' | 'optional';
export type MissingReason = 'notYet' | 'denied' | 'servicesOff';
/** Where "Open Settings" goes: the app's own page, Android's Location page, or the reminder channel's page. */
export type SettingsTarget = 'app' | 'locationServices' | 'reminderChannel';

/** What one read of the phone says about one permission. */
export type PermState =
  | { kind: 'granted' }
  | { kind: 'missing'; reason: MissingReason; canAsk: boolean; target: SettingsTarget }
  | { kind: 'idle' } // not in use: its feature is off, or it is asked when first used
  | { kind: 'unknown' }; // could not be read, or nothing the driver can do

export type MissingState = Extract<PermState, { kind: 'missing' }>;

/** One read of the phone for the board. Never a prompt; never starts the BLE manager. */
export interface PermissionBoardRead {
  snapshot: PermissionSnapshot;
  /** `Platform.Version` on Android; null on iOS. */
  androidApi: number | null;
  /** A DashPal pairing is stored on this phone. */
  paired: boolean;
  /** null: not read (no pairing) or the read failed. */
  bluetooth: BluetoothPermission | null;
  /** null: the read failed. */
  camera: CameraAccess | null;
  /** null: no reminder module here (Expo Go, tests) or the read failed. */
  reminder: TripReminderStatus | null;
}

export interface PermissionDef {
  id: PermissionId;
  /** Unique; Home and Settings sort by it. */
  order: number;
  need: Need;
  platforms: readonly PermissionPlatform[];
  /** False: listed in Settings › Permissions only. */
  homeRow: boolean;
  state(read: PermissionBoardRead): PermState;
}

/** The Android channel of the forgot-to-start reminder's note (`TripReminderNotifier.CHANNEL_ID`). */
export const REMINDER_CHANNEL_ID = 'trip_reminder';

/** Bluetooth scans use location on Android 11 and lower, so there is no Bluetooth permission there. */
export const ANDROID_NEARBY_DEVICES_API = 31;

const GRANTED: PermState = { kind: 'granted' };
const IDLE: PermState = { kind: 'idle' };
const UNKNOWN: PermState = { kind: 'unknown' };

const missing = (reason: MissingReason, canAsk: boolean, target: SettingsTarget = 'app'): MissingState => ({
  kind: 'missing',
  reason,
  canAsk,
  target,
});

const located = (s: PermissionSnapshot) => s.location === 'foreground' || s.location === 'always';

/** Android 11 and lower have no Bluetooth permission (null API reads as current). */
const oldAndroid = (read: PermissionBoardRead) =>
  read.snapshot.platform === 'android' && (read.androidApi ?? ANDROID_NEARBY_DEVICES_API) < ANDROID_NEARBY_DEVICES_API;

function locationState(read: PermissionBoardRead): PermState {
  const s = read.snapshot;
  const android = s.platform === 'android';
  // Every drive fails with the phone's Location Services off, whatever the app's permission says.
  if (s.locationServices === false) return missing('servicesOff', android, android ? 'locationServices' : 'app');
  if (located(s)) return GRANTED;
  return missing(s.location === 'undetermined' ? 'notYet' : 'denied', s.locationCanAskAgain);
}

function preciseState(read: PermissionBoardRead): PermState {
  const s = read.snapshot;
  // The location row covers both cases.
  if (!located(s) || s.locationServices === false) return IDLE;
  if (s.precise === true) return GRANTED;
  if (s.precise === null) return UNKNOWN;
  // Android 12+ shows its "change to precise" dialog for a fresh location request. Whether it still
  // will is not readable while location is allowed, so a request with no effect sends the next tap
  // to Settings (the no-effect rule). iOS changes it only in Settings.
  return missing('denied', s.platform === 'android' && !oldAndroid(read));
}

function motionState(read: PermissionBoardRead): PermState {
  const m = read.snapshot.motion;
  if (m === 'granted') return GRANTED;
  if (m === 'undetermined') return missing('notYet', true);
  // Android may still show its dialog once more; a silent refusal sends the next tap to Settings.
  if (m === 'denied') return missing('denied', read.snapshot.platform === 'android');
  return UNKNOWN; // unavailable, or could not be checked
}

function notificationsState(read: PermissionBoardRead): PermState {
  const s = read.snapshot;
  if (s.notifications === 'granted' || s.notifications === 'provisional') return GRANTED;
  return missing(s.notifications === 'undetermined' ? 'notYet' : 'denied', s.notificationsCanAskAgain);
}

function reminderAccessState(read: PermissionBoardRead): PermState {
  const r = read.reminder;
  if (r === null) return UNKNOWN;
  if (!r.enabled) return IDLE;
  if (r.state === 'unavailable') return UNKNOWN;
  const needs = r.state === 'needs' ? r.missing : [];
  if (read.snapshot.platform === 'ios') {
    // The location row comes first; the reminder's Always need shows once location is allowed.
    if (locationState(read).kind !== 'granted') return IDLE;
    if (needs.includes('locationAlways')) return missing('denied', false);
    // The reminder reports no Always need: granted when the phone agrees; two reads that disagree
    // (one taken just before a change) can't say.
    return read.snapshot.location === 'always' ? GRANTED : UNKNOWN;
  }
  // Android: only the reminder's own channel switched off is this row; app-wide notifications are
  // the notifications row, and motion is the motion row.
  if (needs.includes('notifications') && notificationsState(read).kind === 'granted') return missing('denied', false, 'reminderChannel');
  return GRANTED;
}

function bluetoothState(read: PermissionBoardRead): PermState {
  if (!read.paired || oldAndroid(read)) return IDLE;
  switch (read.bluetooth) {
    case null:
    case 'unavailable':
      return UNKNOWN;
    case 'granted':
      return GRANTED;
    case 'denied':
      return missing('denied', false);
    case 'undetermined':
      // Android: a paired phone allowed Nearby devices before, so not granted now is a revoke. iOS:
      // the DashPal manager has not started yet (the board reads again when its link changes).
      return read.snapshot.platform === 'android' ? missing('denied', false) : UNKNOWN;
  }
}

function cameraState(read: PermissionBoardRead): PermState {
  const c = read.camera;
  if (c === null) return UNKNOWN;
  if (c.access === 'granted') return GRANTED;
  if (c.access === 'undetermined') return IDLE; // asked when a scanner opens
  return missing('denied', false);
}

const BOTH: readonly PermissionPlatform[] = ['ios', 'android'];

export const PERMISSIONS: readonly PermissionDef[] = [
  { id: 'location', order: 10, need: 'required', platforms: BOTH, homeRow: true, state: locationState },
  { id: 'precise', order: 20, need: 'required', platforms: BOTH, homeRow: true, state: preciseState },
  { id: 'motion', order: 30, need: 'recommended', platforms: BOTH, homeRow: true, state: motionState },
  { id: 'notifications', order: 40, need: 'recommended', platforms: BOTH, homeRow: true, state: notificationsState },
  { id: 'reminderAccess', order: 50, need: 'optional', platforms: BOTH, homeRow: true, state: reminderAccessState },
  { id: 'bluetooth', order: 60, need: 'optional', platforms: BOTH, homeRow: true, state: bluetoothState },
  { id: 'camera', order: 70, need: 'optional', platforms: BOTH, homeRow: false, state: cameraState },
];

export const PERMISSION_IDS: readonly PermissionId[] = PERMISSIONS.map((d) => d.id);

export function permissionDef(id: PermissionId): PermissionDef {
  const def = PERMISSIONS.find((d) => d.id === id);
  if (!def) throw new Error(`unknown permission ${id}`);
  return def;
}

export const isPermissionId = (v: unknown): v is PermissionId => typeof v === 'string' && (PERMISSION_IDS as readonly string[]).includes(v);

/** The identity of a missing state: a request that leaves it unchanged had no visible effect. */
export const signature = (s: MissingState): string => `${s.reason}:${s.canAsk}`;
