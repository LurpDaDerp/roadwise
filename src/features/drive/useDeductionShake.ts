import { useEffect, useMemo, useState } from 'react';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { HaloDeduction } from '@/ui/drive';

/** Points coming off as the drive state carries them (`DriveLive.lastDeduction`). */
export interface LiveDeduction {
  key: string;
  points: number;
  /** row clock: the row they came off on */
  at: number;
}

/**
 * The deduction the halo shakes for right now: each new one (by its key and row) for what is left of
 * `ms` (1.5 s, as an alert's flash) on the row clock, then nothing. One already that old when it
 * reaches the screen (it came off while RoadWise was in the background) never shakes, and neither does
 * the one standing when the screen mounts. Between deductions it is null, so a halo drawn again (a new
 * window size) never replays an old shake.
 */
export function useDeductionShake(
  deduction: LiveDeduction | null,
  rowTs: number | null,
  ms: number = ALERT_GLOW_MS
): HaloDeduction | null {
  const id = deduction === null ? null : `${deduction.key}@${deduction.at}`;
  // The deduction standing when the screen mounts is old news.
  const [mountId] = useState(id);
  const [expired, setExpired] = useState<string | null>(null);
  // Its age on the row clock, read once as it arrives.
  const left = useMemo(
    () => (deduction === null ? 0 : ms - (rowTs === null ? 0 : Math.max(0, rowTs - deduction.at))),
    // `id` names the deduction (the object may be a fresh copy of the same one); `rowTs` is read as it
    // arrives, never again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, ms]
  );
  const live = id !== null && id !== mountId && left > 0;
  useEffect(() => {
    if (!live || id === null) return;
    const timer = setTimeout(() => setExpired(id), left);
    return () => clearTimeout(timer);
  }, [live, id, left]);
  const points = deduction?.points ?? 0;
  return useMemo(() => (!live || id === null || id === expired ? null : { key: id, points }), [live, id, expired, points]);
}
