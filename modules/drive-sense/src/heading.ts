// The phone's compass heading on Android (`PhoneHeading`, README §12): the driving screen's compass
// before a drive's first direction of travel. iOS reads expo-location's heading (CLHeading); on
// Android that one comes from the accelerometer and magnetometer with no allowance for a phone
// standing upright in a mount, so Android has its own small native module on the rotation-vector
// sensor. It is a module of its own, so the shared DriveSense events and methods stay the same on
// both platforms; on iOS (and in Jest, Expo Go, web) it does not exist and `available()` is false.
//
// The lookup is `requireOptionalNativeModule`, so importing this file never throws.
import { requireOptionalNativeModule } from 'expo-modules-core';

/** A `heading` event: expo-location's heading shape (`trueHeading` -1 with no location yet; `accuracy` 0-3, 0 unusable). */
export interface PhoneHeadingReading {
  trueHeading: number;
  magHeading: number;
  accuracy: number;
}

type NativePhoneHeading = {
  available(): unknown;
  start(): unknown;
  stop(): unknown;
  addListener(event: 'heading', fn: (payload: unknown) => void): { remove(): void };
};

const native = requireOptionalNativeModule<NativePhoneHeading>('PhoneHeading');

/** The sensor's presence never changes in a process: read once. */
let availableCache: boolean | null = null;

const isReading = (p: unknown): p is PhoneHeadingReading => {
  if (p === null || typeof p !== 'object') return false;
  const { trueHeading, magHeading, accuracy } = p as Record<string, unknown>;
  return typeof trueHeading === 'number' && typeof magHeading === 'number' && typeof accuracy === 'number';
};

export const PhoneHeading = {
  /** Sync. The phone has the native heading (Android with a rotation-vector sensor). Never throws. */
  available(): boolean {
    if (native === null || native === undefined) return false;
    if (availableCache === null) {
      try {
        availableCache = native.available() === true;
      } catch {
        availableCache = false;
      }
    }
    return availableCache;
  },

  /**
   * Starts the heading and hands each reading to `onReading` until the subscription is removed (the
   * sensor stops with the last one). Rejects where there is no native heading. A malformed payload
   * is dropped. The same shape as expo-location's `watchHeadingAsync`.
   */
  async watch(onReading: (h: PhoneHeadingReading) => void): Promise<{ remove(): void }> {
    const n = native;
    if (n === null || n === undefined) throw new Error('PhoneHeading: not available on this platform');
    const sub = n.addListener('heading', (p) => {
      if (isReading(p)) onReading(p);
    });
    let started = false;
    try {
      started = n.start() === true;
    } catch {
      started = false;
    }
    if (!started) {
      sub.remove();
      throw new Error('PhoneHeading: no rotation-vector sensor');
    }
    let removed = false;
    return {
      remove() {
        if (removed) return;
        removed = true;
        sub.remove();
        try {
          n.stop();
        } catch {
          // The runtime is going away: native stops it then anyway.
        }
      },
    };
  },
};
