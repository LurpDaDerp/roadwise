/** @jest-environment node */
// The batcher's predictive flush (Task 3 review I1, round-1 m-r1): at every allowed capture rate, no
// record waits in the batcher for BATCH_MS or more, skipped frames included, and there is no timer.
// Both native Batchers port this rule, and the `batcher-flush` golden vector pins each port to it.
import { ALLOWED_FPS, BATCH_MS } from '../src/constants';
import { batchFlushDue, batcherWaits, runBatcher, type BatcherFrame } from '../src/reference/batcher';

const T0 = 5e8; // about six days of uptime on the record clock

/** Callbacks `deliveryMs` after capture; records appended `lagMs` after capture. */
function stream(fps: number, opts: { lagMs?: number; deliveryMs?: number; skip?: (i: number) => boolean; n?: number } = {}): BatcherFrame[] {
  const interval = 1000 / fps;
  const { lagMs = 45, deliveryMs = 5, skip = () => false, n = fps * 4 } = opts;
  return Array.from({ length: n }, (_, i) => ({
    arriveMs: T0 + i * interval + deliveryMs,
    tMs: T0 + i * interval,
    nowMs: T0 + i * interval + lagMs,
    skipped: skip(i),
  }));
}

describe.each(ALLOWED_FPS.map((fps) => [fps]))('%i fps', (fps) => {
  test.each([
    ['a typical 45 ms lag', 45],
    ['a short 20 ms lag', 20],
    ['a long 90 ms lag', 90],
  ])('with %s every record is flushed, and none waits BATCH_MS or more', (_n, lagMs) => {
    const frames = stream(fps, { lagMs });
    const flushes = runBatcher(1000 / fps, frames, 0);
    const w = batcherWaits(frames, flushes);
    expect(w.length).toBeGreaterThanOrEqual(frames.length - 1); // at most the last record is still pending
    expect(Math.max(...w)).toBeLessThan(BATCH_MS);
    expect(Math.max(...flushes.map((f) => f.n))).toBeLessThanOrEqual(fps > 10 ? 2 : 1);
  });

  test('with every other frame skipped, no record waits BATCH_MS or more (round-1 m-r1)', () => {
    const frames = stream(fps, { skip: (i) => i % 2 === 1 });
    const w = batcherWaits(frames, runBatcher(1000 / fps, frames, 0));
    expect(Math.max(...w)).toBeLessThan(BATCH_MS);
  });
});

test('after a skipped frame, the pending record flushes at the next callback, before its own frame is processed', () => {
  const frames = stream(15, { skip: (i) => i === 1, n: 3 });
  const flushes = runBatcher(1000 / 15, frames, 0);
  expect(flushes[0]).toMatchObject({ after: 2, at: 'arrive', n: 1 });
  expect(batcherWaits(frames, flushes)[0]).toBeLessThan(BATCH_MS);
});

test('the flush condition, at its edges', () => {
  expect(batchFlushDue(T0, 100, T0)).toBe(true); // 10 fps: the first record flushes at once
  expect(batchFlushDue(T0, 1000 / 15, T0)).toBe(false); // 15 fps: the first record may wait for one more
  expect(batchFlushDue(T0 + 1000 / 15, 1000 / 15, T0)).toBe(true);
  expect(batchFlushDue(T0 + 33, 66, T0)).toBe(false); // (33 + 66 = 99) < 100
});

test("the anchor's wall-clock time comes from the same clock as the record times", () => {
  const frames = stream(15, { lagMs: 42 });
  const epochOffset = 1.7e12 - T0;
  const [first] = runBatcher(1000 / 15, frames, epochOffset);
  expect(first!.anchorTMs).toBe(T0);
  expect(first!.anchorEpochMs).toBeCloseTo(T0 + epochOffset, 6);
});

test('negative control: without the check at the top of the callback, a skipped frame makes a record wait ≥ BATCH_MS', () => {
  const frames = stream(15, { skip: (i) => i % 3 === 1 });
  const appendOnly = runBatcher(1000 / 15, frames.map((f) => ({ ...f, arriveMs: -Infinity })), 0);
  const w = batcherWaits(frames, appendOnly);
  expect(Math.max(...w)).toBeGreaterThanOrEqual(BATCH_MS);
});

test('negative control: the rule the review rejected (flush on a later frame once the batch is BATCH_MS old) keeps records waiting ≥ BATCH_MS', () => {
  for (const fps of ALLOWED_FPS) {
    const frames = stream(fps);
    let start = -1;
    let worst = 0;
    for (const f of frames) {
      if (start < 0) start = f.nowMs;
      if (f.nowMs - start >= BATCH_MS) {
        worst = Math.max(worst, f.nowMs - start);
        start = -1;
      }
    }
    expect({ fps, late: worst >= BATCH_MS }).toEqual({ fps, late: true });
  }
});
