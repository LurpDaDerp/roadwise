// The slice of drive-sense the permission adapters use, resolved lazily: nothing native is
// loaded until a snapshot or request asks. `null` where no native DriveSense module exists
// (Jest, Expo Go, web) — callers report motion as unavailable and battery as unknown, never as
// granted. `isIgnoringBatteryOptimizations` is feature-detected on the native module, so a dev
// build that predates it reads as "can't check" rather than a rejected call.
import type { DriveSenseApi, DriveSenseState } from '@drive-sense';

export interface DriveSensePort {
  getState(): Promise<DriveSenseState>;
  requestMotionPermission(): Promise<'granted' | 'denied' | 'unavailable'>;
  isIgnoringBatteryOptimizations?(): Promise<boolean>;
}

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
