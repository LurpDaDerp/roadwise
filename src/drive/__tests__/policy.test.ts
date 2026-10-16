import { autoEndDeadline, createTicker, TICK_MIN_DELAY_MS, TICK_SLACK_MS } from '@/drive/ticks';
import { detectorContext, isBusyStatus, NO_SWITCH, switchSignalFor, tripRecords } from '@/drive/policy';

test('statuses', () => {
  expect(isBusyStatus('idle')).toBe(false);
  expect(isBusyStatus('recording')).toBe(true);
  expect(isBusyStatus('finalizing')).toBe(true);
  expect(tripRecords('recording')).toBe(true);
  expect(tripRecords('finalizing')).toBe(false);
});

test('the detector context follows the call state, the drive switch signal and the platform', () => {
  expect(detectorContext(false, NO_SWITCH, 'android')).toEqual({ callActive: false, switchSignal: 'none', lockDelayMs: null, platform: 'android' });
  expect(detectorContext(true, { signal: 'lagged', lockDelayMs: 11_000 }, 'ios')).toEqual({ callActive: true, switchSignal: 'lagged', lockDelayMs: 11_000, platform: 'ios' });
});

test('the switch signal from getState: Android exact; an iPhone with a passcode proven or not yet; none without one', () => {
  const s = (platform: 'ios' | 'android', lockSignal: 'reliable' | 'lagged' | 'unreliable', lockProof: boolean, lockDelayMs: number | null) => ({ platform, lockSignal, lockProof, lockDelayMs });
  expect(switchSignalFor(s('android', 'reliable', false, null))).toEqual({ signal: 'reliable', lockDelayMs: null });
  expect(switchSignalFor(s('ios', 'unreliable', true, 10_000))).toEqual({ signal: 'none', lockDelayMs: null });
  expect(switchSignalFor(s('ios', 'lagged', true, 10_400))).toEqual({ signal: 'lagged', lockDelayMs: 10_400 });
  expect(switchSignalFor(s('ios', 'lagged', false, null))).toEqual({ signal: 'unproven', lockDelayMs: null });
});

/** A scheduler whose timers the test fires; each entry keeps its delay and whether it is still armed. */
function fakeScheduler() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    timers,
    live: () => timers.filter((t) => t.live),
    scheduler: {
      setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms, live: true }),
      clearTimeout: (h: unknown) => {
        const t = timers[(h as number) - 1];
        if (t) t.live = false;
      },
    },
    fire(t: { fn: () => void; live: boolean }) {
      t.live = false;
      t.fn();
    },
  };
}

test('the ticker arms one timer at autoEndAt + 1 s; null clears it', () => {
  const f = fakeScheduler();
  const now = 1000;
  const ticks: number[] = [];
  const ticker = createTicker({ now: () => now, scheduler: f.scheduler, onTick: (ts) => ticks.push(ts) });
  ticker.update(null);
  expect(f.timers).toHaveLength(0);
  ticker.update(901_000);
  expect(autoEndDeadline(901_000)).toBe(901_000 + TICK_SLACK_MS);
  expect(f.live()).toEqual([expect.objectContaining({ ms: 901_000 + TICK_SLACK_MS - now })]);
  ticker.update(null);
  expect(f.live()).toEqual([]);
  ticker.stop();
});

test('lazy re-arm: a later autoEndAt keeps the armed timer; it fires, and the next update arms the new time; an earlier one re-arms at once', () => {
  const f = fakeScheduler();
  let now = 0;
  const ticks: number[] = [];
  const ticker = createTicker({ now: () => now, scheduler: f.scheduler, onTick: (ts) => ticks.push(ts) });
  ticker.update(900_000);
  for (let s = 1; s <= 600; s += 1) ticker.update(900_000 + s * 1000); // driving: the end moves every second
  expect(f.timers).toHaveLength(1);
  now = 901_000;
  f.fire(f.live()[0]!);
  expect(ticks).toEqual([901_000]);
  ticker.update(1_500_000);
  expect(f.live()).toEqual([expect.objectContaining({ ms: 1_500_000 + TICK_SLACK_MS - now })]);
  ticker.update(1_000_000); // earlier: re-armed
  expect(f.live()).toEqual([expect.objectContaining({ ms: 1_000_000 + TICK_SLACK_MS - now })]);
  expect(f.timers).toHaveLength(3);
  ticker.stop();
  expect(f.live()).toEqual([]);
});

test('a time already past arms the 1 s floor, never 0 ms: a tick held back by the pace grace re-arms once, at the grace’s end', () => {
  expect(TICK_MIN_DELAY_MS).toBe(1000);
  const f = fakeScheduler();
  let now = 2_000_000;
  const ticker = createTicker({ now: () => now, scheduler: f.scheduler, onTick: () => {} });
  ticker.update(1_000_000); // long past (an adopted drive)
  expect(f.live()).toEqual([expect.objectContaining({ ms: TICK_MIN_DELAY_MS })]);
  now += 1000;
  f.fire(f.live()[0]!);
  // The tick found a pace run in progress: autoEndAt moved to the grace's end, 5 s on.
  ticker.update(now + 5000);
  expect(f.live()).toEqual([expect.objectContaining({ ms: 5000 + TICK_SLACK_MS })]);
  expect(f.timers.every((t) => t.ms >= TICK_MIN_DELAY_MS)).toBe(true);
  ticker.stop();
});
