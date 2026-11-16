// Bluetooth for the car link (round 14). "Are you driving?" asks only when Bluetooth is known to be
// on.
// - iPhone: iOS tells an app that only through a Bluetooth manager, and creating one the first time
//   is the permission prompt. So RoadWise asks once, when the driver pairs a car (a denial pairs the
//   car all the same), and remembers that the phone answered. From then on the drive host may create
//   the manager (the DashPal one, shared; it prompts no more) to read the radio.
// - Android 12+: Nearby devices (BLUETOOTH_CONNECT) is asked once, BEFORE the driver's "Use this
//   car" (ruling 14: without it Android 14+ hides the car's Bluetooth address, which pairing keys
//   on), and any answer pairs the car all the same. With it, the radio is read with no prompt (the
//   shared manager, created as on DashPal's Android path). Android 11 and lower need no permission.
// Never asked from a drive. Nothing here throws.
import type { AndroidPermissionsPort, BluetoothPort, RadioState } from './adapters';
import type { SettingsStore } from './types';

/**
 * Settings: this phone answered the Bluetooth permission (iPhone: so creating the manager prompts no
 * more; Android: the car's Nearby devices ask was shown). A fact about the phone, kept across
 * sign-outs and account switches.
 */
export const BLUETOOTH_ANSWERED_KEY = 'device.bluetoothAnswered';
/** Android 12+'s Nearby devices permission the car link needs (reading, never scanning). */
export const ANDROID_BT_CONNECT = 'android.permission.BLUETOOTH_CONNECT';
/** Android's API level from which Bluetooth needs a runtime permission (Android 12). */
export const ANDROID_NEARBY_API = 31;
/** The car check waits this long at most for the radio to report, once the manager exists. */
export const CAR_RADIO_SETTLE_MS = 3_000;

export interface CarBluetoothDeps {
  platform: 'ios' | 'android';
  settings: Pick<SettingsStore, 'get' | 'set'>;
  radio: BluetoothPort;
  /** Android: the runtime permissions and the API level (none needed below 31). */
  android?: CarNearbyDeps;
}

export interface CarNearbyDeps {
  permissions: AndroidPermissionsPort;
  apiLevel: number;
}

/** The radio has an answer: anything but unknown (no manager, or not answered yet) and resetting. */
const settled = (s: RadioState | null): s is RadioState => s !== null && s !== 'unknown' && s !== 'resetting';

async function answered(settings: CarBluetoothDeps['settings']): Promise<boolean> {
  try {
    return (await settings.get<boolean>(BLUETOOTH_ANSWERED_KEY)) === true;
  } catch {
    return false;
  }
}

async function markAnswered(settings: CarBluetoothDeps['settings']): Promise<void> {
  await settings.set(BLUETOOTH_ANSWERED_KEY, true).catch(() => {});
}

/** Android: Nearby devices is allowed (always below Android 12, which has no such permission). */
export async function carNearbyGranted(deps: CarNearbyDeps): Promise<boolean> {
  if (deps.apiLevel < ANDROID_NEARBY_API) return true;
  try {
    return await deps.permissions.check(ANDROID_BT_CONNECT);
  } catch {
    return false;
  }
}

/**
 * Android, as the driver taps "Use this car": Nearby devices is asked for once (Android 12+), unless
 * it is allowed already (for DashPal, say). Resolves whether it is allowed now; the pairing goes on
 * whatever the answer.
 */
export async function askNearbyForCar(deps: { settings: CarBluetoothDeps['settings']; android: CarNearbyDeps }): Promise<boolean> {
  if (await carNearbyGranted(deps.android)) return true;
  if (await answered(deps.settings)) return false;
  try {
    const answers = await deps.android.permissions.requestMultiple([ANDROID_BT_CONNECT]);
    await markAnswered(deps.settings);
    return answers[ANDROID_BT_CONNECT] === 'granted';
  } catch {
    return false;
  }
}

/**
 * The driver paired a car: Bluetooth is asked for once (iPhone; Android asks before the pairing,
 * `askNearbyForCar`). Already answered here (or for DashPal): nothing is shown. Resolves with the
 * radio's state, or null when it was not asked or could not be read.
 */
export async function askBluetoothForCar(deps: CarBluetoothDeps): Promise<RadioState | null> {
  if (deps.platform !== 'ios') return null;
  try {
    const now = await deps.radio.radio();
    if (settled(now)) {
      await markAnswered(deps.settings);
      return now;
    }
    if (await answered(deps.settings)) return null;
    const after = await deps.radio.startRadio();
    if (settled(after)) await markAnswered(deps.settings);
    return settled(after) ? after : null;
  } catch {
    return null;
  }
}

/**
 * The radio for the car check. iPhone: its state when a manager exists; created first (no prompt)
 * only once the phone has answered; otherwise null (unknown), and nothing is created. Android: with
 * Nearby devices allowed (or below Android 12) the radio read, which never prompts there; without
 * it null (unknown).
 */
export async function carRadioState(deps: CarBluetoothDeps): Promise<RadioState | null> {
  if (deps.platform === 'android') {
    if (deps.android === undefined || !(await carNearbyGranted(deps.android))) return null;
    try {
      const now = await deps.radio.radio();
      if (now !== null && settled(now)) return now;
      const started = await deps.radio.startRadio(CAR_RADIO_SETTLE_MS);
      return settled(started) ? started : null;
    } catch {
      return null;
    }
  }
  if (deps.platform !== 'ios') return null;
  try {
    const now = await deps.radio.radio();
    if (now !== null) return settled(now) ? now : null;
    if (!(await answered(deps.settings))) return null;
    const started = await deps.radio.startRadio(CAR_RADIO_SETTLE_MS);
    return settled(started) ? started : null;
  } catch {
    return null;
  }
}
