import { autoEndDeadline, createTicker, TICK_SLACK_MS } from '@/drive/ticks';
import { detectorContext, isBusyStatus, tripRecords, walkingReported } from '@/drive/policy';

test('statuses', () => {
  expect(isBusyStatus('idle')).toBe(false);
  expect(isBusyStatus('recording')).toBe(true);
  expect(isBusyStatus('finalizing')).toBe(true);
  expect(tripRecords('recording')).toBe(true);
  expect(tripRecords('finalizing')).toBe(false);
});

test('the detector context follows the call state', () => {
  expect(detectorContext(false)).toEqual({ callActive: false });
  expect(detectorContext(true)).toEqual({ callActive: true });
});

test('only a confident walk or run (not an exit) is a walking report', () => {
  expect(walkingReported({ type: 'walking', confidence: 'high', ts: 1 })).toBe(true);
  expect(walkingReported({ type: 'running', confidence: 'medium', ts: 1 })).toBe(true);
  expect(walkingReported({ type: 'walking', confidence: 'low', ts: 1 })).toBe(false);
  expect(walkingReported({ type: 'walking', confidence: 'high', ts: 1, exit: true })).toBe(false);
  expect(walkingReported({ type: 'automotive', confidence: 'high', ts: 1 })).toBe(false);
});

test('the ticker keeps one timer at the auto-end deadline, re-armed only when the stop clock moves', () => {
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 1000;
  const ticks: number[] = [];
  const ticker = createTicker({
    now: () => now,
    scheduler: { setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length, clearTimeout: (h) => timers.splice((h as number) - 1, 1, { fn: () => {}, ms: -1 }) },
    onTick: (ts) => ticks.push(ts),
  });
  ticker.update(null);
  expect(timers).toHaveLength(0);
  ticker.update(1000);
  expect(timers).toHaveLength(1);
  expect(timers[0]!.ms).toBe(autoEndDeadline(1000) - 1000);
  expect(autoEndDeadline(1000)).toBe(1000 + 300_000 + TICK_SLACK_MS);
  ticker.update(1000); // same stop: nothing new
  expect(timers).toHaveLength(1);
  now = 50_000;
  ticker.update(50_000); // a new stop: re-armed
  expect(timers.filter((t) => t.ms >= 0)).toHaveLength(1);
  timers.find((t) => t.ms >= 0)!.fn();
  expect(ticks).toEqual([50_000]);
  ticker.update(null);
  ticker.stop();
});
