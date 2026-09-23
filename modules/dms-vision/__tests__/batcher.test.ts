/** @jest-environment node */
// The batcher's predictive flush (Task 3 review I1): at every allowed capture rate, no record waits in
// the batcher for BATCH_MS or more, and there is no timer. Both native Batchers port this rule, and
// the `batcher-flush` golden vector pins each port to it.
import { ALLOWED_FPS, BATCH_MS } from '../src/constants';
import { batchFlushDue, runBatcher, type BatcherFlush, type BatcherFrame } from '../src/reference/batcher';

const T0 = 5e8; // about six days of uptime on the record clock

function nominal(fps: number, lagMs = 30): BatcherFrame[] {
  const interval = 1000 / fps;
  return Array.from({ length: fps * 4 }, (_, i) => ({ tMs: T0 + i * interval, nowMs: T0 + i * interval + lagMs }));
}

/** How long each flushed record sat in the batcher (append → flush). */
function waits(frames: readonly BatcherFrame[], flushes: readonly BatcherFlush[]): number[] {
  const out: number[] = [];
  for (const f of flushes) for (let i = f.after - f.n + 1; i <= f.after; i++) out.push(frames[f.after]!.nowMs - frames[i]!.nowMs);
  return out;
}

describe.each(ALLOWED_FPS.map((fps) => [fps]))('%i fps', (fps) => {
  const frames = nominal(fps);
  const flushes = runBatcher(1000 / fps, frames, 0);

  test('every record is flushed, and none waits BATCH_MS or more', () => {
    const w = waits(frames, flushes);
    expect(w).toHaveLength(frames.length);
    expect(Math.max(...w)).toBeLessThan(BATCH_MS);
  });

  test('batch sizes: one record at ≤ 10 fps, two at 15 fps', () => {
    expect(new Set(flushes.map((f) => f.n))).toEqual(new Set([fps > 10 ? 2 : 1]));
  });
});

test('the flush condition, at its edges', () => {
  expect(batchFlushDue(T0, 100, T0)).toBe(true); // 10 fps: the first record flushes at once
  expect(batchFlushDue(T0, 1000 / 15, T0)).toBe(false); // 15 fps: the first record waits for one more
  expect(batchFlushDue(T0 + 1000 / 15, 1000 / 15, T0)).toBe(true);
  expect(batchFlushDue(T0 + 33, 66, T0)).toBe(false); // (33 + 66 = 99) < 100
});

test("the anchor's wall-clock time comes from the same clock as the record times", () => {
  const frames = nominal(15, 42);
  const epochOffset = 1.7e12 - T0;
  const [first] = runBatcher(1000 / 15, frames, epochOffset);
  expect(first!.anchorTMs).toBe(T0);
  expect(first!.anchorEpochMs).toBeCloseTo(T0 + epochOffset, 6);
});

test('negative control: the rule the review rejected (flush on a later frame once the batch is BATCH_MS old) keeps records waiting ≥ BATCH_MS', () => {
  for (const fps of ALLOWED_FPS) {
    const frames = nominal(fps);
    let start = -1;
    let firstNow = 0;
    let worst = 0;
    for (const f of frames) {
      if (start < 0) {
        start = f.nowMs;
        firstNow = f.nowMs;
      }
      if (f.nowMs - start >= BATCH_MS) {
        worst = Math.max(worst, f.nowMs - firstNow);
        start = -1;
      }
    }
    expect({ fps, late: worst >= BATCH_MS }).toEqual({ fps, late: true });
  }
});
