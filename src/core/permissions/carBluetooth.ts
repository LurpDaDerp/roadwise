// Bluetooth for the car check (iPhone, round 14). "Are you driving?" asks only when Bluetooth is known
// to be on, and iOS tells an app that only through a Bluetooth manager: creating one the first time
// is the permission prompt. So RoadWise asks once, when the driver pairs a car (a denial pairs the
// car all the same), and remembers that the phone answered. From then on the drive host may create
// the manager (the DashPal one, shared; it prompts no more) to read the radio. Never asked off
// iPhone, and never from a drive. Nothing here throws.
import type { BluetoothPort, RadioState } from './adapters';
import type { SettingsStore } from './types';

/**
 * Settings: this phone answered the Bluetooth permission (so creating the manager prompts no more).
 * A fact about the phone, kept across sign-outs and account switches.
 */
export const BLUETOOTH_ANSWERED_KEY = 'device.bluetoothAnswered';
/** The car check waits this long at most for the radio to report, once the manager exists. */
export const CAR_RADIO_SETTLE_MS = 3_000;

export interface CarBluetoothDeps {
  platform: 'ios' | 'android';
  settings: Pick<SettingsStore, 'get' | 'set'>;
  radio: BluetoothPort;
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

/**
 * The driver paired a car: Bluetooth is asked for once (iPhone). Already answered here (or for
 * DashPal): nothing is shown. Resolves with the radio's state, or null when it was not asked or could
 * not be read.
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
 * The radio for the car check: its state when a manager exists; created first (no prompt) only once
 * the phone has answered; otherwise null (unknown), and nothing is created.
 */
export async function carRadioState(deps: CarBluetoothDeps): Promise<RadioState | null> {
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
