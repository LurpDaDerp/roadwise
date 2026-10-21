/**
 * Every permission RoadWise uses, one entry each. Home's permission row and Settings › Permissions
 * are both generated from this table, and the tests iterate it. Each entry turns one read of the
 * phone (`PermissionBoardRead`) into a state. Pure: nothing here touches the OS.
 *
 * Bluetooth and the camera are never requested from here (their `canAsk` is always false): the OS
 * asks for them only where the spec puts them, the DashPal setup and a QR scanner. Location Always
 * and Background App Refresh are iPhone rows: automatic drives need them.
 */
import type { BluetoothPermission, CameraAccess, PermissionPlatform, PermissionSnapshot } from '@/core/permissions';

export type PermissionId =
  | 'location'
  | 'precise'
  | 'locationAlways'
  | 'motion'
  | 'backgroundRefresh'
  | 'notifications'
  | 'bluetooth'
  | 'camera';
export type Need = 'required' | 'recommended' | 'optional';
export type MissingReason = 'notYet' | 'denied' | 'servicesOff';
/** Where "Open Settings" goes: the app's own page, or Android's Location page. */
export type SettingsTarget = 'app' | 'locationServices';

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

/**
 * iPhone: Location set to Always, which automatic drives need. Not in use until location is allowed
 * (the location row comes first). iOS shows its Always prompt once; after that only Settings.
 */
function locationAlwaysState(read: PermissionBoardRead): PermState {
  const s = read.snapshot;
  if (locationState(read).kind !== 'granted') return IDLE;
  if (s.location === 'always') return GRANTED;
  return missing(s.canAskAlways === true ? 'notYet' : 'denied', s.canAskAlways === true);
}

/** iPhone: Background App Refresh, so iOS can wake RoadWise when a drive starts. Only Settings changes it. */
function backgroundRefreshState(read: PermissionBoardRead): PermState {
  switch (read.snapshot.backgroundRefresh) {
    case 'available':
      return GRANTED;
    case 'denied':
      return missing('denied', false);
    default:
      return UNKNOWN; // restricted (nothing the driver can do), or not read
  }
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
const IOS: readonly PermissionPlatform[] = ['ios'];

export const PERMISSIONS: readonly PermissionDef[] = [
  { id: 'location', order: 10, need: 'required', platforms: BOTH, homeRow: true, state: locationState },
  { id: 'precise', order: 20, need: 'required', platforms: BOTH, homeRow: true, state: preciseState },
  { id: 'locationAlways', order: 25, need: 'recommended', platforms: IOS, homeRow: true, state: locationAlwaysState },
  { id: 'motion', order: 30, need: 'recommended', platforms: BOTH, homeRow: true, state: motionState },
  { id: 'backgroundRefresh', order: 35, need: 'recommended', platforms: IOS, homeRow: true, state: backgroundRefreshState },
  { id: 'notifications', order: 40, need: 'recommended', platforms: BOTH, homeRow: true, state: notificationsState },
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
