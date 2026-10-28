/**
 * The windowed reads the Analytics tab and Home's coaching tip need (plan D6). Each key sits under
 * the `stats` root, so the change event that refreshes every stat refreshes these too.
 */
import type { DriveEvent } from '@scoring';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { toEventRow } from '@/data/db/events';
import type { EventRow } from '@/data/db/types';
import { useDataSource } from '@/data/queries/context';
import { queryKeys } from '@/data/queries/keys';
import { isScoredDrive, toListedDrive, toLocalDriveEvent, toTripView, TRIP_VIEW, type LocalDrive } from '@/data/queries/rows';

/** The SQL twin of `isScoredDrive`: scored by the server, or pending and long enough to score. */
export const SCORED_TRIP = "(t.status = 'scored' OR (t.status = 'pending' AND t.reason IS NULL))";

/** An event row as the scoring package reads it (`driveLoads`, `ratingAt`, `driveScore`): speeding's weight reads `measured.overMphS`. */
export function toDriveEvent(row: EventRow): DriveEvent {
  const { measured } = toLocalDriveEvent(row);
  return {
    id: row.id,
    type: row.type,
    tier: row.tier,
    startedAt: row.started_at,
    durationS: row.duration_s,
    status: row.status,
    measured,
  };
}

/**
 * The active events of every scored drive started at or after `sinceMs` (null: all time), oldest
 * first. Events a dispute removed are left out, as they are from the rating.
 */
export async function readWindowEvents(db: Db, sinceMs: number | null): Promise<DriveEvent[]> {
  const since = sinceMs === null ? '' : 'AND t.started_at >= ?';
  const { rows } = await db.execute(
    `SELECT e.* FROM trip_events e JOIN trips t ON t.client_trip_id = e.client_trip_id
     WHERE e.status = 'active' AND ${SCORED_TRIP} ${since}
     ORDER BY e.started_at ASC, e.id ASC`,
    sinceMs === null ? [] : [sinceMs]
  );
  return rows.map((row) => toDriveEvent(toEventRow(row)));
}

/**
 * The scored drives started at or after `sinceMs` (null: all time), newest first. A list read: each
 * drive's stored server answer is left unread (`toListedDrive`).
 */
export async function readScoredDrives(db: Db, sinceMs: number | null): Promise<LocalDrive[]> {
  const since = sinceMs === null ? '' : 'AND t.started_at >= ?';
  const { rows } = await db.execute(
    `SELECT ${TRIP_VIEW} FROM trips t WHERE ${SCORED_TRIP} ${since} ORDER BY t.started_at DESC, t.client_trip_id ASC`,
    sinceMs === null ? [] : [sinceMs]
  );
  return rows.map((row) => toListedDrive(toTripView(row))).filter(isScoredDrive);
}

/**
 * Active events of the window's scored drives (the radar's category loads). The window's start moves
 * every hour, which is a new key: the last answer stays until the new one lands.
 */
export function useWindowEvents(sinceMs: number | null): UseQueryResult<DriveEvent[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.windowEvents(sinceMs), queryFn: () => readWindowEvents(db, sinceMs), placeholderData: keepPreviousData });
}

/** Scored drives in the window, newest first; null: all time (personal bests). Held across a new window like the events. */
export function useScoredDrives(sinceMs: number | null): UseQueryResult<LocalDrive[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.scoredDrives(sinceMs), queryFn: () => readScoredDrives(db, sinceMs), placeholderData: keepPreviousData });
}
