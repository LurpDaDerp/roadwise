// The measured frame rate (plan §M6, rev0): 1000 / the median frame dt over the last `fpsWindowS`. It
// gates blink statistics (≥ blinkMinFps), PERCLOS, yawns and the gaze rules (the floors sit between
// capture rates, T6 review I2). Pure; bounded.
import type { DmsConfig } from './config';
import { RingBuffer } from './windows';

const MAX_FPS = 30;

/** Index of the first element ≥ v in the ascending array. */
function lowerBound(a: readonly number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createFpsMeter(cfg: Pick<DmsConfig, 'closure'>) {
  const windowMs = cfg.closure.fpsWindowS * 1000;
  const frames = new RingBuffer<{ t: number; dt: number }>(Math.ceil(cfg.closure.fpsWindowS * MAX_FPS) + 2);
  // The window's dts kept sorted (insert and remove by binary search): the median is O(1) to read and
  // O(n) memmove to maintain, instead of a sort per frame (it ran on every frame of the façade, Task 12).
  const sorted: number[] = [];
  const remove = (dt: number) => {
    const i = lowerBound(sorted, dt);
    if (i < sorted.length && sorted[i] === dt) sorted.splice(i, 1);
  };
  let last: number | null = null;
  let cached = 0;
  return {
    push(tMs: number): void {
      if (last !== null && tMs > last) {
        if (frames.size === frames.capacity) remove(frames.first()!.dt);
        const dt = tMs - last;
        frames.push({ t: tMs, dt });
        sorted.splice(lowerBound(sorted, dt), 0, dt);
        frames.dropWhile((x) => {
          if (x.t > tMs - windowMs) return false;
          remove(x.dt);
          return true;
        });
        const n = sorted.length;
        const m = n === 0 ? 0 : n % 2 === 1 ? sorted[n >> 1]! : (sorted[(n >> 1) - 1]! + sorted[n >> 1]!) / 2;
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
      sorted.length = 0;
      last = null;
      cached = 0;
    },
  };
}
