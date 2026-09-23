// The measured frame rate (plan §M6, rev0): 1000 / the median frame dt over the last `fpsWindowS`. It
// gates blink statistics (≥ blinkMinFps), PERCLOS, yawns and the gaze rules (the floors sit between
// capture rates, T6 review I2). Pure; bounded.
import type { DmsConfig } from './config';
import { median } from './stats';
import { RingBuffer } from './windows';

const MAX_FPS = 30;

export function createFpsMeter(cfg: Pick<DmsConfig, 'closure'>) {
  const windowMs = cfg.closure.fpsWindowS * 1000;
  const frames = new RingBuffer<{ t: number; dt: number }>(Math.ceil(cfg.closure.fpsWindowS * MAX_FPS) + 2);
  let last: number | null = null;
  // Cached: recomputed only when the window changes (T9 review nit), not on every read.
  let cached = 0;
  return {
    push(tMs: number): void {
      if (last !== null && tMs > last) {
        frames.push({ t: tMs, dt: tMs - last });
        frames.dropWhile((x) => x.t <= tMs - windowMs);
        const m = median(frames.toArray().map((x) => x.dt));
        cached = m > 0 ? 1000 / m : 0;
      }
      last = tMs;
    },
    /** 0 before two frames. */
    fps(): number {
      return frames.size === 0 ? 0 : cached;
    },
    reset(): void {
      frames.clear();
      last = null;
      cached = 0;
    },
  };
}
