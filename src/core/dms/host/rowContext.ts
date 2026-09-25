// The 1 Hz row seam (plan Task 14, rev2 R1-m1, R-8). The drive engine's FeatureRow → the DMS engine's
// row extras and the capture policy's row. IMU motion is the drive engine's own ¬stillWithoutFix: one
// definition, never a copy.
import { stillWithoutFix } from '@/core/engine/machine';
import type { MotionEvidence } from '@/core/engine/motionEvidence';
import type { FeatureRow } from '@/core/engine/types';
import type { RowExtras } from '../engine/context';
import type { PolicyRow } from '../policy/capture';

/** handlingScore at or above this is phone handling (SEARCH; the engine's own context uses its config). */
const HANDLING_MIN = 0.6;

/** `motion`: the row's shared motion evidence (Task C1), carried as given; omitted when none. */
export function rowExtras(row: FeatureRow, power: { localMinutes: number | null }, tripElapsedS: number, motion?: MotionEvidence): RowExtras {
  const ex: RowExtras = { imuMoving: !stillWithoutFix(row), localMinutes: power.localMinutes, tripElapsedS };
  if (motion !== undefined) ex.motion = motion;
  return ex;
}

export function policyRow(row: FeatureRow, motion?: MotionEvidence): PolicyRow {
  const known = row.gnssValid && row.speed >= 0;
  const out: PolicyRow = { tMs: row.ts, speedKmh: known ? row.speed * 3.6 : null, imuMoving: !stillWithoutFix(row), handling: row.handlingScore >= HANDLING_MIN };
  if (motion !== undefined) out.motion = motion;
  return out;
}
