// The slice of drive-sense the permission adapters use, resolved lazily: nothing native is
// loaded until a snapshot or request asks. `null` where no native DriveSense module exists
// (Jest, Expo Go, web) — callers report motion as unavailable and battery as unknown, never as
// granted. `isIgnoringBatteryOptimizations` is feature-detected on the native module, so a dev
// build that predates it reads as "can't check" rather than a rejected call. So is Android's
// "Pause app activity if unused" read (`getUnusedAppRestrictions`, native's
// PackageManagerCompat.getUnusedAppRestrictionsStatus): a build without it reads as not readable. The
// drive detector (`DriveDetect`, iOS and Android) is a second port: what automatic drives need
// (Location Always / Allow all the time, Background App Refresh / battery not Restricted, the
// lock-screen surface) and the Always request; null where the phone has none.
import type { DetectState, DriveSenseApi } from '@drive-sense';

/** Android's unused-app restriction for RoadWise as native answers it (`unavailable`: no such feature on this phone). */
export type UnusedAppRestrictions = 'enabled' | 'disabled' | 'unavailable';

export interface DriveSensePort {
  getState(): ReturnType<DriveSenseApi['getState']>;
  requestMotionPermission(): Promise<'granted' | 'denied' | 'unavailable'>;
  isIgnoringBatteryOptimizations?(): Promise<boolean>;
  /** Android 11+: present only in a native build that has it. */
  getUnusedAppRestrictions?(): Promise<UnusedAppRestrictions>;
}

/** The drive detector's permission reads and its Always request (iOS and Android). */
export interface DriveDetectPort {
  getState(): Promise<DetectState>;
  /**
   * iOS: the one Always request, only from While Using, once per install; otherwise the current
   * answer. Android: "Allow all the time" (the system dialog, or its settings page on 11+).
   */
  requestAlways(): Promise<'always' | 'whenInUse' | 'denied'>;
}

const UNUSED_APP_RESTRICTIONS: readonly string[] = ['enabled', 'disabled', 'unavailable'];

type Wrapper = Pick<DriveSenseApi, 'getState' | 'requestMotionPermission' | 'isIgnoringBatteryOptimizations'>;

export interface DriveSenseLoaders {
  /** The raw native module (for feature detection), or null when it does not exist. */
  loadNative(): Promise<Record<string, unknown> | null>;
  /** The typed, validating JS wrapper (`@drive-sense`'s default export). */
  loadWrapper(): Promise<Wrapper>;
}

const defaultLoaders: DriveSenseLoaders = {
  async loadNative() {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    return requireOptionalNativeModule<Record<string, unknown>>('DriveSense');
  },
  async loadWrapper() {
    return (await import('@drive-sense')).default;
  },
};

/** A resolver that loads once and reuses the port; a failed load is retried on the next call. */
export function createDriveSenseResolver(
  loaders: DriveSenseLoaders
): () => Promise<DriveSensePort | null> {
  let pending: Promise<DriveSensePort | null> | null = null;
  return () => {
    pending ??= (async () => {
      const native = await loaders.loadNative();
      if (!native) return null;
      const ds = await loaders.loadWrapper();
      const port: DriveSensePort = {
        getState: () => ds.getState(),
        requestMotionPermission: () => ds.requestMotionPermission(),
      };
      if (typeof native.isIgnoringBatteryOptimizations === 'function') {
        port.isIgnoringBatteryOptimizations = () => ds.isIgnoringBatteryOptimizations();
      }
      const unused = native.getUnusedAppRestrictions;
      if (typeof unused === 'function') {
        // Straight to the native function (the typed wrapper predates it); an answer outside the
        // contract is refused, so the board reads it as not readable rather than guessing.
        port.getUnusedAppRestrictions = async () => {
          const v: unknown = await (unused as () => Promise<unknown>).call(native);
          if (typeof v !== 'string' || !UNUSED_APP_RESTRICTIONS.includes(v)) throw new Error('getUnusedAppRestrictions: unexpected answer');
          return v as UnusedAppRestrictions;
        };
      }
      return port;
    })().catch(() => {
      pending = null;
      return null;
    });
    return pending;
  };
}

export const resolveDriveSense: () => Promise<DriveSensePort | null> =
  createDriveSenseResolver(defaultLoaders);

/** The native drive detector (iOS, Android), or null where it does not exist (Jest, Expo Go, web). */
export async function resolveDriveDetect(): Promise<DriveDetectPort | null> {
  try {
    const { DriveDetect } = await import('@drive-sense');
    return DriveDetect.available ? DriveDetect : null;
  } catch {
    return null;
  }
}
