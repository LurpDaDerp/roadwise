import { useEffect, useMemo, useState } from 'react';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { EventShake } from '@/core/engine/engine.types';
import type { HaloShake } from '@/ui/drive';

import { useAppActive } from './useHaloBurst';

/**
 * The event the halo shakes for right now (`DriveLive.lastShake`: a hard brake, start or turn as it
 * is confirmed, a speeding episode as it alerts): each new one (by its key and row) for what is
 * left of `ms` (1.5 s, as an alert's flash) on the row clock, then nothing; its tier sizes the shake.
 * It shakes only while RoadWise is in front: one first seen while it is not never shakes, then or
 * later, and neither does one already that old when it reaches the screen, nor the one standing
 * when the screen mounts. Between events it is null, so a halo drawn again (a new window size)
 * never replays an old shake.
 */
export function useEventShake(shake: EventShake | null, rowTs: number | null, ms: number = ALERT_GLOW_MS): HaloShake | null {
  const id = shake === null ? null : `${shake.key}@${shake.at}`;
  const active = useAppActive();
  // The event standing when the screen mounts is old news.
  const [mountId] = useState(id);
  // The last one first seen while RoadWise was not in front (React's state-from-the-previous-render
  // pattern: set once per such event, so this settles at once).
  const [awayId, setAwayId] = useState<string | null>(null);
  if (!active && id !== null && id !== mountId && id !== awayId) setAwayId(id);
  const [expired, setExpired] = useState<string | null>(null);
  // Its age on the row clock, read once as it arrives.
  const left = useMemo(
    () => (shake === null ? 0 : ms - (rowTs === null ? 0 : Math.max(0, rowTs - shake.at))),
    // `id` names the event (the object may be a fresh copy of the same one); `rowTs` is read as it
    // arrives, never again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, ms]
  );
  const live = active && id !== null && id !== mountId && id !== awayId && left > 0;
  useEffect(() => {
    if (!live || id === null) return;
    const timer = setTimeout(() => setExpired(id), left);
    return () => clearTimeout(timer);
  }, [live, id, left]);
  const tier = shake?.tier ?? 'moderate';
  return useMemo(() => (!live || id === null || id === expired ? null : { key: id, tier }), [live, id, expired, tier]);
}
