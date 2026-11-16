/**
 * Every permission RoadWise uses, one entry each. Home's permission row and Settings › Permissions
 * are both generated from this table, and the tests iterate it. Each entry turns one read of the
 * phone (`PermissionBoardRead`) into a state. Pure: nothing here touches the OS.
 *
 * Bluetooth and the camera are never requested from here (their `canAsk` is always false): the OS
 * asks for them only where the spec puts them: the DashPal setup, pairing a car and a QR scanner. Location Always
 * (Android: "Allow all the time") and Background App Refresh (Android: battery usage not Restricted)
 * are automatic drives' rows, listed on Android only where the phone has the drive detector; Battery
 * Saver limiting location and "Pause app activity if unused" are Android's own rows for them (the
 * second on Android 11 and later, where it can be read).
 */
import type { BluetoothPermission, CameraAccess, PermissionPlatform, PermissionSnapshot } from '@/core/permissions';

export type PermissionId =
  | 'location'
  | 'precise'
  | 'locationAlways'
  | 'motion'
  | 'backgroundRefresh'
  | 'batterySaver'
  | 'unusedApps'
  | 'notifications'
  | 'bluetooth'
  | 'camera';
export type Need = 'required' | 'recommended' | 'optional';
export type MissingReason = 'notYet' | 'denied' | 'servicesOff';
/**
 * Where "Open Settings" goes: the app's own page, Android's Location page, its Battery Saver page or
 * the page with "Pause app activity if unused".
 */
export type SettingsTarget = 'app' | 'locationServices' | 'batterySaver' | 'unusedApps';

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
  /** iPhone: a car is paired on the car link (Bluetooth lets "Are you driving?" check the radio). */
  carPaired?: boolean;
  /** null: not read (no DashPal or car paired) or the read failed. */
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
  /** Whether this phone lists the row at all (default: always, on its platforms). */
  listed?(read: PermissionBoardRead): boolean;
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
 * Location set to Always (Android: "Allow all the time"), which automatic drives need. Not in use
 * until location is allowed (the location row comes first). iOS shows its Always prompt once; after
 * that only Settings. Android can always ask: the drive detector shows the system's dialog or, on
 * Android 11 and later, its settings page (a request with no effect still sends the next tap to
 * Settings, the no-effect rule).
 */
function locationAlwaysState(read: PermissionBoardRead): PermState {
  const s = read.snapshot;
  if (locationState(read).kind !== 'granted') return IDLE;
  if (s.location === 'always') return GRANTED;
  if (s.platform === 'android') return missing(s.canAskAlways === false ? 'denied' : 'notYet', true);
  return missing(s.canAskAlways === true ? 'notYet' : 'denied', s.canAskAlways === true);
}

/**
 * What lets the phone wake RoadWise when a drive starts: iOS Background App Refresh; Android's
 * battery usage for RoadWise, missing while it is set to Restricted. Only Settings changes it.
 */
function backgroundRefreshState(read: PermissionBoardRead): PermState {
  switch (read.snapshot.backgroundRefresh) {
    case 'available':
      return GRANTED;
    case 'denied':
      return missing('denied', false);
    case 'restricted':
      // Android: battery use is not Restricted, and Battery Saver limits location (its own row).
      // iPhone: restricted by the phone's management, nothing the driver can do.
      return read.snapshot.platform === 'android' ? GRANTED : UNKNOWN;
    default:
      return UNKNOWN; // not read
  }
}

/**
 * Android: Battery Saver is on with a location mode that stops fixes with the screen off or RoadWise
 * behind (the detector reports it as `backgroundRefresh` `restricted`), so drives can be missed or
 * cut short. A row of its own, so hiding it from Home never hides battery use set to Restricted.
 * Never a need of the Automatic drives switch (its native status leaves it out); only Battery
 * Saver's own page changes it. Not in use while Battery Saver leaves location alone, or while battery
 * use is Restricted (that row comes first and the detector reports only it).
 */
function batterySaverState(read: PermissionBoardRead): PermState {
  return read.snapshot.backgroundRefresh === 'restricted' ? missing('denied', false, 'batterySaver') : IDLE;
}

/**
 * Android 11 and later: "Pause app activity if unused", which takes RoadWise's permissions back (and
 * on 12 and later stops its background work) after a few months unopened, so automatic drives would
 * stop. A tip: only Settings changes it (the page with the switch), and nothing can be done where it
 * can't be read.
 */
function unusedAppsState(read: PermissionBoardRead): PermState {
  switch (read.snapshot.unusedAppPause) {
    case 'off':
      return GRANTED;
    case 'on':
      return missing('denied', false, 'unusedApps');
    default:
      return UNKNOWN;
  }
}

function bluetoothState(read: PermissionBoardRead): PermState {
  if ((!read.paired && read.carPaired !== true) || oldAndroid(read)) return IDLE;
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
      // the DashPal manager has not started yet (the board reads again when its link changes); with
      // only a car paired, the phone has not answered yet (Settings › Your car asks once): not in use.
      if (read.snapshot.platform === 'android') return missing('denied', false);
      return read.paired ? UNKNOWN : IDLE;
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
const ANDROID: readonly PermissionPlatform[] = ['android'];

/**
 * Automatic drives' rows: every iPhone lists them; an Android phone only once its drive detector has
 * answered (a phone without one, such as one with no Google Play services, has no automatic drives).
 */
const autoRowsListed = (read: PermissionBoardRead): boolean => read.snapshot.platform === 'ios' || read.snapshot.canAskAlways !== null;

/** Android 10 added background location as a permission of its own. */
export const ANDROID_BACKGROUND_LOCATION_API = 29;

/**
 * Android 9 and lower: allowing location allows it in the background too, so on a phone with the
 * drive detector (which would then use it with the app closed) the location request is itself a
 * background-location request, and Google Play's disclosure comes before it. A null API reads as
 * current.
 */
export const locationIsBackground = (read: Pick<PermissionBoardRead, 'snapshot' | 'androidApi'>): boolean =>
  read.snapshot.platform === 'android' &&
  read.snapshot.canAskAlways !== null &&
  (read.androidApi ?? ANDROID_BACKGROUND_LOCATION_API) < ANDROID_BACKGROUND_LOCATION_API;

/**
 * Whether this fix carries Google Play's background-location disclosure first (Android only): every
 * Location Always fix, and the location request where it allows background location too.
 */
export function disclosesBackground(id: PermissionId, state: MissingState, read: PermissionBoardRead): boolean {
  if (read.snapshot.platform !== 'android') return false;
  if (id === 'locationAlways') return true;
  return id === 'location' && state.reason !== 'servicesOff' && locationIsBackground(read);
}

export const PERMISSIONS: readonly PermissionDef[] = [
  { id: 'location', order: 10, need: 'required', platforms: BOTH, homeRow: true, state: locationState },
  { id: 'precise', order: 20, need: 'required', platforms: BOTH, homeRow: true, state: preciseState },
  { id: 'locationAlways', order: 25, need: 'recommended', platforms: BOTH, homeRow: true, listed: autoRowsListed, state: locationAlwaysState },
  { id: 'motion', order: 30, need: 'recommended', platforms: BOTH, homeRow: true, state: motionState },
  { id: 'backgroundRefresh', order: 35, need: 'recommended', platforms: BOTH, homeRow: true, listed: autoRowsListed, state: backgroundRefreshState },
  { id: 'batterySaver', order: 36, need: 'recommended', platforms: ANDROID, homeRow: true, listed: autoRowsListed, state: batterySaverState },
  { id: 'unusedApps', order: 37, need: 'optional', platforms: ANDROID, homeRow: false, listed: autoRowsListed, state: unusedAppsState },
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
