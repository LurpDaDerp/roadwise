/**
 * The scores a list of drives shows on its rows (Home's recent drives, Drive history). A row's
 * drive carries no events, so the events of every listed drive that can have a score are read in
 * one query and each drive is scored on the phone, exactly as its recap does.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys, readDriveEvents, useDataSource } from '@/data/queries';

import type { LocalDrive } from './model';
import { driveKind, driveScoreOf } from './summary';

/** Each listed drive's score by id; a drive with no score (or whose events are still loading) is absent. */
export function useDriveScores(drives: readonly LocalDrive[] | undefined): ReadonlyMap<string, number> {
  const { db } = useDataSource();
  const scorable = useMemo(() => (drives ?? []).filter((d) => driveKind(d).kind === 'scorable'), [drives]);
  const ids = useMemo(() => scorable.map((d) => d.clientTripId), [scorable]);
  // While a changed list loads, the last answer stands: a drive it read keeps its score, a new one waits.
  const events = useQuery({
    queryKey: queryKeys.driveEvents(ids.join(',')),
    queryFn: () => readDriveEvents(db, ids),
    placeholderData: keepPreviousData,
  });
  return useMemo(() => {
    const out = new Map<string, number>();
    const byTrip = events.data;
    if (!byTrip) return out;
    for (const d of scorable) {
      const list = byTrip.get(d.clientTripId);
      if (list === undefined) continue;
      const s = driveScoreOf(d, list);
      if (s !== null) out.set(d.clientTripId, s);
    }
    return out;
  }, [scorable, events.data]);
}
