// The OS side of permission health: reads the phone into a `PermissionSnapshot` and makes the
// few requests the app is allowed to make. Every dependency is injectable; the defaults load
// expo-location, expo-notifications, expo-battery and drive-sense lazily, on first use, so
// importing this module touches nothing native. Reads happen only when a caller asks (on mount /
// return to foreground) — no polling, no timers, no listeners (design §3.5).
//
// Callers still apply the one prompt policy (`canPrompt` / `recordPrompt`) around every request.
import { Linking, PermissionsAndroid, Platform } from 'react-native';

import type { ReminderLocationAnswer } from '@drive-sense';

import { blockedDuringDrive } from '@/drive/leave';

import { resolveDriveSense, type DriveSensePort } from './driveSensePort';
import type {
  BatteryOptimization,
  Grant,
  LocationAccess,
  NotificationAccess,
  PermissionPlatform,
  PermissionSnapshot,
} from './types';

/** The fields of expo-location's `LocationPermissionResponse` this module reads. */
export interface LocationAnswer {
  status: string;
  canAskAgain: boolean;
  ios?: { scope?: string; accuracy?: string };
  android?: { accuracy?: string };
}

export interface LocationPort {
  getForegroundPermissionsAsync(): Promise<LocationAnswer>;
  getBackgroundPermissionsAsync(): Promise<LocationAnswer>;
  requestForegroundPermissionsAsync(): Promise<LocationAnswer>;
}

/** The fields of expo-notifications' `NotificationPermissionsStatus` this module reads. */
export interface NotificationAnswer {
  status: string;
  canAskAgain: boolean;
  /** `IosAuthorizationStatus`: 3 = PROVISIONAL. */
  ios?: { status?: number };
}

export interface NotificationRequest {
  ios: { allowAlert: boolean; allowBadge: boolean; allowSound: boolean };
}

export interface NotificationsPort {
  getPermissionsAsync(): Promise<NotificationAnswer>;
  requestPermissionsAsync(req?: NotificationRequest): Promise<NotificationAnswer>;
}

export interface BatteryPort {
  isLowPowerModeEnabledAsync(): Promise<boolean>;
}

export interface LinkingPort {
  openSettings(): Promise<void>;
  sendIntent(action: string): Promise<void>;
}

/**
 * The Bluetooth radio as the DashPal BLE manager reports it (`src/dashcam/bluetoothPort.ts`; no
 * ble-manager import here). `radio()` never creates the iOS manager, so it never prompts: null when
 * there is none yet. `startRadio()` creates it (iOS: that is the permission prompt, the first time)
 * and resolves with the first state that is not unknown/resetting.
 */
export type RadioState = 'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'off' | 'on' | 'turning_on' | 'turning_off';
export interface BluetoothPort {
  radio(): Promise<RadioState | null>;
  startRadio(): Promise<RadioState>;
}

/** Android's runtime permission calls, narrowed (React Native's `PermissionsAndroid`). */
export interface AndroidPermissionsPort {
  check(permission: string): Promise<boolean>;
  requestMultiple(permissions: string[]): Promise<Record<string, string>>;
}

/**
 * Bluetooth for DashPal: `granted` (allowed, radio on), `off` (allowed, radio off), `denied`,
 * `undetermined` (never asked, or not readable without asking), `unavailable` (no Bluetooth LE).
 */
export type BluetoothAccess = 'granted' | 'off' | 'denied' | 'undetermined' | 'unavailable';

export const ANDROID_BT_PERMISSIONS = ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT'] as const;
export const ANDROID_FINE_LOCATION = 'android.permission.ACCESS_FINE_LOCATION';

export interface PermissionsAdapterDeps {
  platform: PermissionPlatform;
  location: LocationPort;
  notifications: NotificationsPort;
  battery: BatteryPort;
  linking: LinkingPort;
  driveSense: () => Promise<DriveSensePort | null>;
  now: () => number;
  /** Default: the DashPal transport's radio, loaded on first use. */
  bluetooth?: BluetoothPort;
  /** Default: React Native's `PermissionsAndroid`. */
  androidPermissions?: AndroidPermissionsPort;
  /** Default: `Platform.Version` on Android. */
  androidApiLevel?: () => number;
}

export interface Readiness {
  /** drive-sense reports what a drive needs: While-Using (or Always) location and granted motion. */
  allowed: boolean;
}

export interface PermissionsAdapter {
  /** A read, never a prompt. */
  snapshot(): Promise<PermissionSnapshot>;
  requestLocationForeground(): Promise<LocationAccess>;
  /**
   * Through drive-sense `requestMotionPermission()` on both platforms; `unavailable` stays so.
   * null when it could not be asked or checked (no drive-sense, or the request and re-read failed).
   */
  requestMotion(): Promise<Grant | null>;
  /** Alert, badge and sound — never a provisional (quiet) authorisation. */
  requestNotifications(): Promise<NotificationAccess>;
  openAppSettings(): Promise<void>;
  /** Android's battery-optimisation list; the app's Settings page where that is unavailable. */
  openBatterySettings(): Promise<void>;
  readiness(): Promise<Readiness>;
  /** A read, never a prompt (iOS: `undetermined` until the DashPal manager exists). */
  bluetooth(): Promise<BluetoothAccess>;
  /**
   * DashPal only, on the driver's tap (never asked of anyone without a DashPal): iOS creates the
   * BLE manager and reads its first state; Android 12+ asks Nearby devices (scan + connect),
   * Android 11 and below fine location (Bluetooth scans need it there).
   */
  requestBluetooth(): Promise<BluetoothAccess>;
  /**
   * The forgot-to-start reminder only, on the driver's tap that turns it on: iOS asks once for
   * "Always" (While Using must already be granted; never asked twice). Android uses no location for
   * it: `notNeeded`. `denied` when it could not be asked at all.
   */
  requestAlwaysForReminder(): Promise<ReminderLocationAnswer>;
}

export const IGNORE_BATTERY_OPTIMIZATION_SETTINGS =
  'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

/** iOS `IosAuthorizationStatus.PROVISIONAL`. */
const IOS_PROVISIONAL = 3;

const NOTIFICATION_REQUEST: NotificationRequest = {
  ios: { allowAlert: true, allowBadge: true, allowSound: true },
};

// ——— lazy defaults: each native module is imported on its first call ———

const lazyLocation: LocationPort = {
  getForegroundPermissionsAsync: async () =>
    (await import('expo-location')).getForegroundPermissionsAsync(),
  getBackgroundPermissionsAsync: async () =>
    (await import('expo-location')).getBackgroundPermissionsAsync(),
  requestForegroundPermissionsAsync: async () =>
    (await import('expo-location')).requestForegroundPermissionsAsync(),
};

const lazyNotifications: NotificationsPort = {
  getPermissionsAsync: async () => (await import('expo-notifications')).getPermissionsAsync(),
  requestPermissionsAsync: async (req) =>
    (await import('expo-notifications')).requestPermissionsAsync(req),
};

const lazyBattery: BatteryPort = {
  isLowPowerModeEnabledAsync: async () => (await import('expo-battery')).isLowPowerModeEnabledAsync(),
};

// Every Settings page RoadWise opens goes through here. During a drive it opens nothing and says
// "End the drive first": leaving RoadWise mid-drive counts as phone use (src/drive/leave.ts).
const rnLinking: LinkingPort = {
  openSettings: async () => {
    if (blockedDuringDrive()) return;
    await Linking.openSettings();
  },
  sendIntent: async (action) => {
    if (blockedDuringDrive()) return;
    await Linking.sendIntent(action);
  },
};

const lazyBluetooth: BluetoothPort = {
  radio: async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the BLE native module
    const { dashpalRadio } = require('@/dashcam/bluetoothPort') as typeof import('@/dashcam/bluetoothPort');
    return dashpalRadio.radio();
  },
  startRadio: async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the BLE native module
    const { dashpalRadio } = require('@/dashcam/bluetoothPort') as typeof import('@/dashcam/bluetoothPort');
    return dashpalRadio.startRadio();
  },
};

const rnAndroidPermissions: AndroidPermissionsPort = {
  check: (permission) => PermissionsAndroid.check(permission as never),
  requestMultiple: async (permissions) => (await PermissionsAndroid.requestMultiple(permissions as never)) as Record<string, string>,
};

function defaultDeps(): PermissionsAdapterDeps {
  return {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    location: lazyLocation,
    notifications: lazyNotifications,
    battery: lazyBattery,
    linking: rnLinking,
    driveSense: resolveDriveSense,
    now: () => Date.now(),
    bluetooth: lazyBluetooth,
    androidPermissions: rnAndroidPermissions,
    androidApiLevel: () => (typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 0),
  };
}

/** The radio's state as access, once the OS permission itself is known to be granted. */
function fromRadio(state: RadioState | null): BluetoothAccess {
  switch (state) {
    case null:
    case 'unknown':
    case 'resetting':
      return 'undetermined';
    case 'unauthorized':
      return 'denied';
    case 'unsupported':
      return 'unavailable';
    case 'on':
    case 'turning_on':
      return 'granted';
    case 'off':
    case 'turning_off':
      return 'off';
  }
}

// ——— mapping ———

const granted = (a: LocationAnswer): boolean => a.status === 'granted';

function toLocationAccess(fg: LocationAnswer, bg: LocationAnswer | null): LocationAccess {
  if (granted(fg)) return bg && granted(bg) ? 'always' : 'foreground';
  return fg.status === 'undetermined' ? 'undetermined' : 'denied';
}

function toPrecise(platform: PermissionPlatform, fg: LocationAnswer): boolean | null {
  if (!granted(fg)) return null;
  const accuracy = platform === 'ios' ? fg.ios?.accuracy : fg.android?.accuracy;
  if (accuracy === 'full' || accuracy === 'fine') return true;
  if (accuracy === 'reduced' || accuracy === 'coarse') return false;
  return null;
}

function toNotificationAccess(a: NotificationAnswer): NotificationAccess {
  if (a.ios?.status === IOS_PROVISIONAL) return 'provisional';
  if (a.status === 'granted') return 'granted';
  return a.status === 'undetermined' ? 'undetermined' : 'denied';
}

export function createPermissionsAdapter(
  overrides: Partial<PermissionsAdapterDeps> = {}
): PermissionsAdapter {
  const deps: PermissionsAdapterDeps = { ...defaultDeps(), ...overrides };

  /** Foreground answer, plus the background one only when foreground is granted. */
  async function readLocation(): Promise<{ fg: LocationAnswer; bg: LocationAnswer | null }> {
    const fg = await deps.location.getForegroundPermissionsAsync();
    const bg = granted(fg) ? await deps.location.getBackgroundPermissionsAsync() : null;
    return { fg, bg };
  }

  const locationAccess = async (): Promise<LocationAccess> => {
    const { fg, bg } = await readLocation();
    return toLocationAccess(fg, bg);
  };

  /** null = could not be checked (no drive-sense in this build, or its read failed). */
  async function readMotion(port: DriveSensePort | null): Promise<Grant | null> {
    if (!port) return null;
    try {
      return (await port.getState()).motion;
    } catch {
      return null;
    }
  }

  async function readBattery(port: DriveSensePort | null): Promise<BatteryOptimization> {
    if (deps.platform === 'ios') return 'exempt'; // iOS has no per-app restriction to report.
    if (!port?.isIgnoringBatteryOptimizations) return 'unknown';
    try {
      return (await port.isIgnoringBatteryOptimizations()) ? 'exempt' : 'optimized';
    } catch {
      return 'unknown';
    }
  }

  async function readLowPower(): Promise<boolean | null> {
    try {
      return await deps.battery.isLowPowerModeEnabledAsync();
    } catch {
      return null;
    }
  }

  return {
    async snapshot() {
      const port = await deps.driveSense();
      const [{ fg, bg }, notif, motion, batteryOptimization, lowPowerMode] = await Promise.all([
        readLocation(),
        deps.notifications.getPermissionsAsync(),
        readMotion(port),
        readBattery(port),
        readLowPower(),
      ]);
      const location = toLocationAccess(fg, bg);
      return {
        platform: deps.platform,
        location,
        precise: toPrecise(deps.platform, fg),
        locationCanAskAgain: location === 'foreground' && bg ? bg.canAskAgain : fg.canAskAgain,
        motion,
        notifications: toNotificationAccess(notif),
        notificationsCanAskAgain: notif.canAskAgain,
        batteryOptimization,
        lowPowerMode,
        checkedAt: deps.now(),
      };
    },

    async requestLocationForeground() {
      await deps.location.requestForegroundPermissionsAsync();
      return locationAccess();
    },

    async requestMotion() {
      const port = await deps.driveSense();
      if (!port) return null;
      const current = await readMotion(port);
      if (current === 'unavailable' || current === 'granted') return current;
      // A state that could not be read is still asked: the request itself reports the answer.
      try {
        return await port.requestMotionPermission();
      } catch {
        return readMotion(port);
      }
    },

    async requestNotifications() {
      return toNotificationAccess(await deps.notifications.requestPermissionsAsync(NOTIFICATION_REQUEST));
    },

    openAppSettings: () => deps.linking.openSettings(),

    async openBatterySettings() {
      if (deps.platform === 'android') {
        try {
          await deps.linking.sendIntent(IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
          return;
        } catch {
          // Some OEM builds have no such screen: the app's own page is the next best place.
        }
      }
      await deps.linking.openSettings();
    },

    async readiness() {
      const port = await deps.driveSense();
      if (!port) return { allowed: false };
      try {
        const s = await port.getState();
        return { allowed: s.location !== 'none' && s.motion === 'granted' };
      } catch {
        return { allowed: false };
      }
    },

    async bluetooth() {
      const radio = deps.bluetooth ?? lazyBluetooth;
      if (deps.platform === 'ios') return fromRadio(await radio.radio());
      if (!(await androidBluetoothGranted())) return 'undetermined';
      // Android: reading the radio shows no prompt.
      return fromRadio(await radio.startRadio());
    },

    async requestAlwaysForReminder() {
      if (deps.platform === 'android') return 'notNeeded';
      const port = await deps.driveSense();
      if (!port?.requestReminderLocation) return 'denied';
      try {
        return await port.requestReminderLocation();
      } catch {
        return 'denied';
      }
    },

    async requestBluetooth() {
      const radio = deps.bluetooth ?? lazyBluetooth;
      if (deps.platform === 'ios') return fromRadio(await radio.startRadio());
      const perms = deps.androidPermissions ?? rnAndroidPermissions;
      const needed = androidBluetoothPermissions();
      const answers = await perms.requestMultiple([...needed]);
      if (!needed.every((p) => answers[p] === 'granted')) return 'denied';
      return fromRadio(await radio.startRadio());
    },
  };

  function androidBluetoothPermissions(): readonly string[] {
    const level = (deps.androidApiLevel ?? (() => 31))();
    return level >= 31 ? ANDROID_BT_PERMISSIONS : [ANDROID_FINE_LOCATION];
  }

  async function androidBluetoothGranted(): Promise<boolean> {
    const perms = deps.androidPermissions ?? rnAndroidPermissions;
    for (const p of androidBluetoothPermissions()) if (!(await perms.check(p))) return false;
    return true;
  }
}
