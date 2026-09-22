// Time base and second windows (README §7 "Time base" and "Windows"; review I2).
//
// Sensor and fix timestamps come on a monotonic boot clock (Android `elapsedRealtimeNanos`, iOS
// `systemUptime`). They are converted to epoch ms through ONE anchor taken when the capture
// starts, so a wall-clock change mid-drive cannot reorder samples. Each row's window is
// (previous row's ts, this ts] — never (ts − 1000, ts] off a jittery timer, which would drop or
// double-count samples — except for the first row of a capture or after a stall.
import type { FixSample } from './types';

/** A converted timestamp further than this from its arrival time falls back to the arrival time. */
export const TIMEBASE_MAX_SKEW_MS = 2000;
/** A gap between row timestamps longer than this starts over: the next window is (ts − 1000, ts]. */
export const MAX_ROW_GAP_MS = 2000;
/** The window of a capture's first row (and of the first row after a stall). */
export const FIRST_WINDOW_MS = 1000;

/**
 * Taken once per capture, at `startCapture`, reading both clocks back to back:
 * Android `{ System.currentTimeMillis(), SystemClock.elapsedRealtimeNanos() / 1e6 }`;
 * iOS `{ Date().timeIntervalSince1970 * 1000, ProcessInfo.processInfo.systemUptime * 1000 }`.
 */
export interface ClockAnchor {
  epochMs: number;
  clockMs: number;
}

/**
 * Boot-clock ms → epoch ms. `arrivalEpochMs` is the wall clock when the sample reached native code;
 * a conversion more than TIMEBASE_MAX_SKEW_MS away from it (a device with a different sensor time
 * base) falls back to it, and `fellBack` lets the port count it for diagnostics.
 */
export function toEpochMs(
  clockMs: number,
  anchor: ClockAnchor,
  arrivalEpochMs: number
): { t: number; fellBack: boolean } {
  const t = anchor.epochMs + (clockMs - anchor.clockMs);
  return Math.abs(t - arrivalEpochMs) > TIMEBASE_MAX_SKEW_MS
    ? { t: arrivalEpochMs, fellBack: true }
    : { t, fellBack: false };
}

/** Exclusive start of the window closing at `ts`. */
export function windowStart(prevTs: number | null, ts: number): number {
  return prevTs === null || ts - prevTs > MAX_ROW_GAP_MS ? ts - FIRST_WINDOW_MS : prevTs;
}

/**
 * Split a buffer (any order) into the window `(start, ts]`, sorted oldest first, and what is kept
 * for later windows (`t > ts`). Items at or before `start` belong to a closed window and are
 * dropped; `dropped` counts them.
 */
export function takeWindow<T extends { t: number }>(
  buffer: readonly T[],
  start: number,
  ts: number
): { inWindow: T[]; rest: T[]; dropped: number } {
  const inWindow: T[] = [];
  const rest: T[] = [];
  let dropped = 0;
  for (const item of buffer) {
    if (item.t > ts) rest.push(item);
    else if (item.t > start) inWindow.push(item);
    else dropped++;
  }
  inWindow.sort((a, b) => a.t - b.t);
  return { inWindow, rest, dropped };
}

/** The window's fix: the one with the latest fix timestamp in `(start, ts]`, whatever the arrival order. */
export function pickFix(fixes: readonly FixSample[], start: number, ts: number): FixSample | null {
  let best: FixSample | null = null;
  for (const f of fixes) {
    if (f.t > start && f.t <= ts && (best === null || f.t > best.t)) best = f;
  }
  return best;
}
