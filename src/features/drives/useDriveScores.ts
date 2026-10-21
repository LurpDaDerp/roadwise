/**
 * The scores a list of drives shows on its rows (Home's recent drives, Drive history). A row's
 * drive carries no events, so each drive that can have a score reads its own (the recap's query,
 * shared with it) and scores them on the phone, exactly as its recap does.
 */
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys, readDriveDetail, useDataSource } from '@/data/queries';

import type { LocalDrive, LocalDriveEvent } from './model';
import { driveKind, driveScoreOf } from './summary';

type Detail = { drive: LocalDrive; events: LocalDriveEvent[] } | null;

/** Each loaded drive's score by id (a stable function, so react-query keeps the map until a result changes). */
function scoresOf(results: UseQueryResult<Detail>[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const r of results) {
    if (!r.data) continue;
    const s = driveScoreOf(r.data.drive, r.data.events);
    if (s !== null) out.set(r.data.drive.clientTripId, s);
  }
  return out;
}

/** Each listed drive's score by id; a drive with no score (or still loading) is absent. */
export function useDriveScores(drives: readonly LocalDrive[] | undefined): ReadonlyMap<string, number> {
  const { db } = useDataSource();
  const scorable = useMemo(() => (drives ?? []).filter((d) => driveKind(d).kind === 'scorable'), [drives]);
  return useQueries({
    queries: scorable.map((d) => ({ queryKey: queryKeys.drive(d.clientTripId), queryFn: (): Promise<Detail> => readDriveDetail(db, d.clientTripId) })),
    combine: scoresOf,
  });
}
