// The OS side of permission health: reads the phone into a `PermissionSnapshot` and makes the
// few requests the app is allowed to make. Every dependency is injectable; the defaults load
// expo-location, expo-notifications, expo-battery and drive-sense lazily, on first use, so
// importing this module touches nothing native. Reads happen only when a caller asks (on mount /
// return to foreground) — no polling, no timers, no listeners (design §3.5).
//
// Callers still apply the one prompt policy (`canPrompt` / `recordPrompt`) around every request.
import { Linking, Platform } from 'react-native';

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
  requestBackgroundPermissionsAsync(): Promise<LocationAnswer>;
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

export interface PermissionsAdapterDeps {
  platform: PermissionPlatform;
  location: LocationPort;
  notifications: NotificationsPort;
  battery: BatteryPort;
  linking: LinkingPort;
  driveSense: () => Promise<DriveSensePort | null>;
  now: () => number;
}

export interface Readiness {
  /** drive-sense reports what arming needs: Always location and granted motion. */
  allowed: boolean;
  /** drive-sense's own `armed`; null when it could not be checked. */
  armed: boolean | null;
}

export interface PermissionsAdapter {
  /** A read, never a prompt. */
  snapshot(): Promise<PermissionSnapshot>;
  requestLocationForeground(): Promise<LocationAccess>;
  /**
   * Asks for Always. Makes no OS request — only returns the current access — on iOS before the
   * first completed drive (design §5.3), without foreground location (one prompt per screen:
   * foreground comes first), or when Always is already granted.
   */
  requestLocationAlways(opts: { firstDriveDone: boolean }): Promise<LocationAccess>;
  /** Through drive-sense `requestMotionPermission()` on both platforms; `unavailable` stays so. */
  requestMotion(): Promise<Grant>;
  /** Alert, badge and sound — never a provisional (quiet) authorisation. */
  requestNotifications(): Promise<NotificationAccess>;
  openAppSettings(): Promise<void>;
  /** Android's battery-optimisation list; the app's Settings page where that is unavailable. */
  openBatterySettings(): Promise<void>;
  readiness(): Promise<Readiness>;
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
  requestBackgroundPermissionsAsync: async () =>
    (await import('expo-location')).requestBackgroundPermissionsAsync(),
};

const lazyNotifications: NotificationsPort = {
  getPermissionsAsync: async () => (await import('expo-notifications')).getPermissionsAsync(),
  requestPermissionsAsync: async (req) =>
    (await import('expo-notifications')).requestPermissionsAsync(req),
};

const lazyBattery: BatteryPort = {
  isLowPowerModeEnabledAsync: async () => (await import('expo-battery')).isLowPowerModeEnabledAsync(),
};

const rnLinking: LinkingPort = {
  openSettings: () => Linking.openSettings(),
  sendIntent: (action) => Linking.sendIntent(action),
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
  };
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

  async function readMotion(port: DriveSensePort | null): Promise<Grant> {
    if (!port) return 'unavailable';
    try {
      return (await port.getState()).motion;
    } catch {
      return 'unavailable';
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

    async requestLocationAlways({ firstDriveDone }) {
      const current = await locationAccess();
      if (current !== 'foreground') return current;
      if (deps.platform === 'ios' && !firstDriveDone) return current;
      await deps.location.requestBackgroundPermissionsAsync();
      return locationAccess();
    },

    async requestMotion() {
      const port = await deps.driveSense();
      if (!port) return 'unavailable';
      const current = await readMotion(port);
      if (current === 'unavailable' || current === 'granted') return current;
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
      if (!port) return { allowed: false, armed: null };
      try {
        const s = await port.getState();
        return { allowed: s.location === 'always' && s.motion === 'granted', armed: s.armed };
      } catch {
        return { allowed: false, armed: null };
      }
    },
  };
}
