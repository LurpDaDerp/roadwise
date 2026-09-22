/** @jest-environment node */
// Review I2: the time base and the second windows the native ports group samples with.
import {
  MAX_ROW_GAP_MS,
  TIMEBASE_MAX_SKEW_MS,
  pickFix,
  takeWindow,
  toEpochMs,
  windowStart,
} from '../src/extract/timebase';
import type { FixSample } from '../src/extract/types';

const T0 = 1_700_000_000_000;
const anchor = { epochMs: T0, clockMs: 5_000_000 };

describe('toEpochMs', () => {
  test('converts through the capture anchor', () => {
    expect(toEpochMs(5_000_250, anchor, T0 + 900)).toEqual({ t: T0 + 250, fellBack: false });
  });

  test('a batched sample arriving 1 s late keeps its sensor time', () => {
    expect(toEpochMs(5_000_100, anchor, T0 + 1_100)).toEqual({ t: T0 + 100, fellBack: false });
  });

  test(`more than ${TIMEBASE_MAX_SKEW_MS} ms from arrival falls back to arrival`, () => {
    // a device whose sensor clock is not elapsedRealtime: hours off
    expect(toEpochMs(9_000_000, anchor, T0 + 500)).toEqual({ t: T0 + 500, fellBack: true });
    expect(toEpochMs(5_000_000 - TIMEBASE_MAX_SKEW_MS - 1, anchor, T0)).toEqual({ t: T0, fellBack: true });
    expect(toEpochMs(5_000_000 + TIMEBASE_MAX_SKEW_MS, anchor, T0)).toEqual({
      t: T0 + TIMEBASE_MAX_SKEW_MS,
      fellBack: false,
    });
  });
});

describe('windows', () => {
  test('the first row, and the row after a stall, take (ts − 1000, ts]', () => {
    expect(windowStart(null, T0 + 1000)).toBe(T0);
    expect(windowStart(T0, T0 + MAX_ROW_GAP_MS + 1)).toBe(T0 + MAX_ROW_GAP_MS + 1 - 1000);
  });

  test('otherwise (previous ts, ts] — a late timer loses nothing, an early one counts nothing twice', () => {
    expect(windowStart(T0 + 1000, T0 + 2300)).toBe(T0 + 1000); // timer slipped 300 ms: 1.3 s window
    expect(windowStart(T0 + 2300, T0 + 3000)).toBe(T0 + 2300); // caught up: 0.7 s window
  });

  test('consecutive windows over a jittery timer cover every sample exactly once', () => {
    const samples = Array.from({ length: 200 }, (_, k) => ({ t: T0 + 20 + k * 40 }));
    const ticks = [T0 + 1000, T0 + 2300, T0 + 3000, T0 + 3900, T0 + 5100, T0 + 6000, T0 + 7000, T0 + 8020];
    let buffer = samples;
    let prev: number | null = null;
    const seen: number[] = [];
    for (const ts of ticks) {
      const w = takeWindow(buffer, windowStart(prev, ts), ts);
      expect(w.dropped).toBe(0);
      seen.push(...w.inWindow.map((s) => s.t));
      buffer = w.rest;
      prev = ts;
    }
    expect(seen).toEqual(samples.filter((s) => s.t <= T0 + 8020).map((s) => s.t));
  });

  test('takeWindow sorts, keeps later samples, drops ones from a closed window', () => {
    const w = takeWindow([{ t: 5 }, { t: 3 }, { t: 12 }, { t: 1 }, { t: 10 }], 2, 10);
    expect(w.inWindow.map((s) => s.t)).toEqual([3, 5, 10]);
    expect(w.rest.map((s) => s.t)).toEqual([12]);
    expect(w.dropped).toBe(1);
  });

  test('the fix is chosen by its own timestamp, not by arrival order', () => {
    const fix = (t: number): FixSample => ({ t, lat: 0, lng: 0, hAcc: 5, speed: 1, speedAcc: 1, course: 0, alt: 0 });
    // arrival order: the 900 ms fix arrived after the next window's 1100 ms one
    const arrived = [fix(T0 + 1100), fix(T0 + 900), fix(T0 + 400)];
    expect(pickFix(arrived, T0, T0 + 1000)?.t).toBe(T0 + 900);
    expect(pickFix(arrived, T0 + 1000, T0 + 2000)?.t).toBe(T0 + 1100);
    expect(pickFix(arrived, T0 + 2000, T0 + 3000)).toBeNull();
  });
});
