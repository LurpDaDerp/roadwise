/**
 * One speed read for the DashPal nearby prompt (`src/dashcam/detector.ts`): a last-known fix no
 * older than 10 s, else one fresh fix awaited at most 2 s; null when unknown. Never a watch.
 */
import * as Location from 'expo-location';

export const MOVING_FIX_MAX_AGE_MS = 10_000;
export const MOVING_FIX_TIMEOUT_MS = 2_000;

interface FixLike {
  timestamp: number;
  coords: { speed: number | null };
}

export interface MovingDeps {
  getLastKnownPositionAsync(opts: { maxAge: number }): Promise<FixLike | null>;
  getCurrentPositionAsync(opts: { accuracy: Location.Accuracy }): Promise<FixLike>;
  now(): number;
}

const defaultDeps: MovingDeps = {
  getLastKnownPositionAsync: (opts) => Location.getLastKnownPositionAsync(opts),
  getCurrentPositionAsync: (opts) => Location.getCurrentPositionAsync(opts),
  now: () => Date.now(),
};

const speedOf = (fix: FixLike | null): number | null => {
  const speed = fix?.coords.speed;
  return typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : null;
};

function within<T>(ms: number, p: Promise<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/** m/s, or null when no fix with a speed was to be had inside the bound. */
export async function currentSpeedMps(deps: MovingDeps = defaultDeps): Promise<number | null> {
  try {
    const last = await deps.getLastKnownPositionAsync({ maxAge: MOVING_FIX_MAX_AGE_MS });
    if (last && deps.now() - last.timestamp <= MOVING_FIX_MAX_AGE_MS) {
      const speed = speedOf(last);
      if (speed !== null) return speed;
    }
  } catch {
    // Fall through to a fresh fix.
  }
  const fresh = await within(MOVING_FIX_TIMEOUT_MS, deps.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
  return speedOf(fresh);
}
