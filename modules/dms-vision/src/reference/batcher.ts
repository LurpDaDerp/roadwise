// The frames batcher's flush rule (README §5; Task 3 review I1), which both native `Batcher`s port.
//
// There is no flush timer. After each record is appended, the batch is flushed when the NEXT frame
// could not arrive before the batch turns BATCH_MS old:
//
//   (nowMs − startedAtMs) + intervalMs ≥ BATCH_MS
//
// `startedAtMs` is the processing time of the batch's first record, and `intervalMs` is
// 1000 / (the capture cap). At ≤ 10 fps every record flushes as it is appended. At 15 fps a batch
// holds two records, and the first one waits one frame interval (≈ 67 ms). At nominal cadence no
// record waits BATCH_MS or more. `≥` rather than `>` is what keeps 10 fps (interval = BATCH_MS)
// below the budget. The subtraction comes first so that at the first record it is exactly 0.
//
// The anchor's wall-clock time is derived from the clock the record times are on (the rebased base
// clock on Android, the host clock on iOS): anchorEpochMs = epochNow − (baseNow − anchorTMs), with
// epochNow and baseNow read together.
import { BATCH_MS } from '../constants';

export function batchFlushDue(nowMs: number, intervalMs: number, startedAtMs: number): boolean {
  return nowMs - startedAtMs + intervalMs >= BATCH_MS;
}

export interface BatcherFrame {
  /** the record's time on the record clock */
  tMs: number;
  /** when the record is appended, on the same clock */
  nowMs: number;
}

export interface BatcherFlush {
  /** the index of the frame whose append flushed the batch */
  after: number;
  n: number;
  anchorTMs: number;
  anchorEpochMs: number;
}

/**
 * Appends every frame in order and reports each flush. The wall clock read with a frame's `nowMs`
 * is `nowMs + epochOffsetMs`. Records still pending at the end are not reported (native flushes them
 * on pause or stop).
 */
export function runBatcher(intervalMs: number, frames: readonly BatcherFrame[], epochOffsetMs: number): BatcherFlush[] {
  const out: BatcherFlush[] = [];
  let first = -1;
  let startedAtMs = 0;
  let anchorEpochMs = 0;
  frames.forEach((f, i) => {
    if (first < 0) {
      first = i;
      startedAtMs = f.nowMs;
      anchorEpochMs = f.nowMs + epochOffsetMs - (f.nowMs - f.tMs);
    }
    if (batchFlushDue(f.nowMs, intervalMs, startedAtMs)) {
      out.push({ after: i, n: i - first + 1, anchorTMs: frames[first]!.tMs, anchorEpochMs });
      first = -1;
    }
  });
  return out;
}
