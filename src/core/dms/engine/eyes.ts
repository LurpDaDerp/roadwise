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
  return {
    push(tMs: number): void {
      if (last !== null && tMs > last) {
        frames.push({ t: tMs, dt: tMs - last });
        frames.dropWhile((x) => x.t <= tMs - windowMs);
      }
      last = tMs;
    },
    /** 0 before two frames. */
    fps(): number {
      if (frames.size === 0) return 0;
      const m = median(frames.toArray().map((x) => x.dt));
      return m > 0 ? 1000 / m : 0;
    },
    reset(): void {
      frames.clear();
      last = null;
    },
  };
}
