// The frames batcher's flush rule (README §5; Task 3 review I1 and round-1 m-r1), which both native
// `Batcher`s port.
//
// There is no flush timer. The predicate is
//
//   (nowMs − startedAtMs) + intervalMs ≥ BATCH_MS
//
// ("the next frame could not arrive before the batch turns BATCH_MS old"), with `startedAtMs` the
// append time of the batch's first record and `intervalMs` = 1000 / (the capture cap). It is checked
// at two points:
// 1. at the TOP of every camera callback, before any early return (throttle, a detection in flight,
//    not running), at the callback's time. A frame that is then skipped can no longer stretch a batch
//    past one interval (Task 3 round-1 review m-r1);
// 2. after each record is appended, at the append time.
// At ≤ 10 fps every record flushes as it is appended; at 15 fps a batch holds one or two records. No
// record waits BATCH_MS or more while callbacks keep their nominal cadence. `≥` rather than `>` keeps
// 10 fps (interval = BATCH_MS) below the budget. The subtraction comes first, so at the first record
// it is exactly 0.
//
// The anchor's wall-clock time is derived from the clock the record times are on (the rebased base
// clock on Android, the host clock on iOS): anchorEpochMs = epochNow − (baseNow − anchorTMs), with
// epochNow and baseNow read together at the batch's first append.
import { BATCH_MS } from '../constants';

export function batchFlushDue(nowMs: number, intervalMs: number, startedAtMs: number): boolean {
  return nowMs - startedAtMs + intervalMs >= BATCH_MS;
}

/** One camera callback. */
export interface BatcherFrame {
  /** the callback's time on the record clock (the check at the top) */
  arriveMs: number;
  /** the record's time on the record clock */
  tMs: number;
  /** when its record is appended, on the same clock (ignored when skipped) */
  nowMs: number;
  /** the frame is dropped (throttle, in flight, error) and appends nothing */
  skipped: boolean;
}

export interface BatcherFlush {
  /** the index of the callback whose check flushed the batch */
  after: number;
  /** 'arrive': the check at the top of the callback; 'append': the check after its record */
  at: 'arrive' | 'append';
  n: number;
  anchorTMs: number;
  anchorEpochMs: number;
}

/**
 * Runs the callbacks in order and reports each flush. The wall clock read with a time `x` is
 * `x + epochOffsetMs`. Records still pending at the end are not reported (native flushes them on
 * pause or stop).
 */
export function runBatcher(intervalMs: number, frames: readonly BatcherFrame[], epochOffsetMs: number): BatcherFlush[] {
  const out: BatcherFlush[] = [];
  let first = -1;
  let count = 0;
  let startedAtMs = 0;
  let anchorEpochMs = 0;
  const flush = (i: number, at: BatcherFlush['at']) => {
    out.push({ after: i, at, n: count, anchorTMs: frames[first]!.tMs, anchorEpochMs });
    first = -1;
    count = 0;
  };
  frames.forEach((f, i) => {
    if (count > 0 && batchFlushDue(f.arriveMs, intervalMs, startedAtMs)) flush(i, 'arrive');
    if (f.skipped) return;
    if (count === 0) {
      first = i;
      startedAtMs = f.nowMs;
      anchorEpochMs = f.nowMs + epochOffsetMs - (f.nowMs - f.tMs);
    }
    count += 1;
    if (batchFlushDue(f.nowMs, intervalMs, startedAtMs)) flush(i, 'append');
  });
  return out;
}

/** How long each flushed record waited in the batcher (append → the flushing check). */
export function batcherWaits(frames: readonly BatcherFrame[], flushes: readonly BatcherFlush[]): number[] {
  const waits: number[] = [];
  let pending: number[] = [];
  let k = 0;
  frames.forEach((f, i) => {
    while (k < flushes.length && flushes[k]!.after === i && flushes[k]!.at === 'arrive') {
      for (const j of pending) waits.push(f.arriveMs - frames[j]!.nowMs);
      pending = [];
      k += 1;
    }
    if (f.skipped) return;
    pending.push(i);
    while (k < flushes.length && flushes[k]!.after === i && flushes[k]!.at === 'append') {
      for (const j of pending) waits.push(f.nowMs - frames[j]!.nowMs);
      pending = [];
      k += 1;
    }
  });
  return waits;
}
