import { useEffect, useState } from 'react';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { carriedSpeed } from '@/core/engine/displaySpeed';

/** Between rows the shown speed moves on this often… */
export const SPEED_TICK_MS = 250;
/** …along the row's acceleration, for at most this long (a late row stops it rather than guessing on). */
export const CARRY_MAX_MS = 1_000;

/**
 * The speed to show now (mph): the row's speed carried on along its acceleration (mph/s) since it
 * landed, re-read every `SPEED_TICK_MS` for up to `CARRY_MAX_MS`, then still until the next row
 * (`rowTs`). Cruising, 0 and "—" never tick.
 */
export function useCarriedSpeed(speedMph: number | null, accelMph: number, rowTs: number | null): number | null {
  const [elapsed, setElapsed] = useState(0);
  const [row, setRow] = useState(rowTs);
  // A new row starts from its own speed in the same render (React's state-from-props pattern).
  if (row !== rowTs) {
    setRow(rowTs);
    setElapsed(0);
  }
  const moving = speedMph !== null && speedMph > 0 && accelMph !== 0;
  useEffect(() => {
    if (!moving) return;
    const start = Date.now();
    const id = setInterval(() => {
      const e = Math.min(Date.now() - start, CARRY_MAX_MS);
      setElapsed(e);
      if (e >= CARRY_MAX_MS) clearInterval(id);
    }, SPEED_TICK_MS);
    return () => clearInterval(id);
  }, [moving, rowTs]);
  if (speedMph === null || !moving) return speedMph;
  return carriedSpeed(speedMph * MPS_PER_MPH, accelMph * MPS_PER_MPH, elapsed, CARRY_MAX_MS) / MPS_PER_MPH;
}
