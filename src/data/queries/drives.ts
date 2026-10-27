/**
 * The local drive data every screen reads (plan §10). Each hook is a namespaced key over a pure
 * reader; the readers are exported so a test can run them against sql.js directly.
 *
 * Every reader asks SQLite for only what it shows: a count is a COUNT, the recent drives a LIMIT,
 * a sum reads the summed columns, and a list leaves each drive's stored server answer unread. The
 * rows, their order and every number are those of filtering the whole table, as before.
 */
import type { StatSums } from '@scoring';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { asEnum, asNumber, asNumberOrNull, asTextOrNull } from '@/data/db/row';
import { createTripsRepo, toTripRow } from '@/data/db/trips';
import { TRIP_STATUSES } from '@/data/db/types';
import { SCORED_TRIP } from '@/data/queries/analytics';
import { useDataSource } from '@/data/queries/context';
import { queryKeys, type DriveHistoryFilter } from '@/data/queries/keys';
import {
  matchesHistoryFilter,
  parseCounts,
  sumStats,
  toListedDrive,
  toLocalDrive,
  toLocalDriveEvent,
  type LocalDrive,
  type LocalDriveEvent,
  type SummedDrive,
} from '@/data/queries/rows';

export type { DriveCounts, DriveStatus, LocalDrive, LocalDriveEvent } from '@/data/queries/rows';

export async function readDrives(db: Db): Promise<LocalDrive[]> {
  const rows = await createTripsRepo(db).list();
  return rows.map(toLocalDrive);
}

/** The order every list reads in (`trips.list`). */
const NEWEST_FIRST = 'ORDER BY t.started_at DESC, t.client_trip_id ASC';

export async function readRecentDrives(db: Db, limit: number): Promise<LocalDrive[]> {
  const { rows } = await db.execute(`SELECT * FROM trips t WHERE t.status != 'recording' ${NEWEST_FIRST} LIMIT ?`, [Math.max(0, limit)]);
  return rows.map((row) => toLocalDrive(toTripRow(row)));
}

export async function readDriveHistory(db: Db, filter: DriveHistoryFilter): Promise<LocalDrive[]> {
  const { rows } = await db.execute(`SELECT * FROM trips t WHERE t.status != 'recording' ${NEWEST_FIRST}`);
  return rows.map((row) => toListedDrive(toTripRow(row))).filter((d) => matchesHistoryFilter(d, filter));
}

export async function readDriveDetail(
  db: Db,
  clientTripId: string
): Promise<{ drive: LocalDrive; events: LocalDriveEvent[] } | null> {
  const row = await createTripsRepo(db).get(clientTripId);
  if (row === null) return null;
  const events = await createEventsRepo(db).listByTrip(clientTripId);
  return { drive: toLocalDrive(row), events: events.map(toLocalDriveEvent) };
}

/** The summed columns of the scored drives in the window, newest first: the order (and so the sums) of the whole-table read. */
export async function readStatSums(db: Db, sinceMs: number | null): Promise<StatSums> {
  const since = sinceMs === null ? '' : 'AND t.started_at >= ?';
  const { rows } = await db.execute(
    `SELECT t.status, t.reason, t.started_at, t.miles, t.duration_s, t.night_miles, t.clean, t.counts_json FROM trips t
     WHERE ${SCORED_TRIP} ${since} ${NEWEST_FIRST}`,
    sinceMs === null ? [] : [sinceMs]
  );
  const drives = rows.map((row): SummedDrive => {
    const clean = asNumberOrNull(row, 'clean');
    return {
      status: asEnum(row, 'status', TRIP_STATUSES),
      reason: asTextOrNull(row, 'reason'),
      startedAt: asNumber(row, 'started_at'),
      miles: asNumber(row, 'miles'),
      durationS: asNumber(row, 'duration_s'),
      nightMiles: asNumber(row, 'night_miles'),
      clean: clean === null ? null : clean !== 0,
      counts: parseCounts(asTextOrNull(row, 'counts_json')),
    };
  });
  return sumStats(drives, sinceMs);
}

export async function readDriveCount(db: Db): Promise<number> {
  const { rows } = await db.execute(`SELECT count(*) AS n FROM trips t WHERE ${SCORED_TRIP}`);
  return asNumber(rows[0] ?? {}, 'n');
}

export async function readRoutePolylines(db: Db, sinceMs: number | null): Promise<string[]> {
  const since = sinceMs === null ? '' : 'AND t.started_at >= ?';
  const { rows } = await db.execute(
    `SELECT t.polyline FROM trips t WHERE t.status != 'recording' AND t.polyline IS NOT NULL AND t.polyline != '' ${since} ${NEWEST_FIRST}`,
    sinceMs === null ? [] : [sinceMs]
  );
  return rows.map((row) => asTextOrNull(row, 'polyline') ?? '');
}

/** The last `limit` drives, newest first (Home's "Recent drives"). */
export function useRecentDrives(limit: number): UseQueryResult<LocalDrive[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.recentDrives(limit), queryFn: () => readRecentDrives(db, limit) });
}

/** History, newest first; `passenger` = "wasn't driving". */
export function useDriveHistory(filter: DriveHistoryFilter): UseQueryResult<LocalDrive[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.driveHistory(filter), queryFn: () => readDriveHistory(db, filter) });
}

/** One drive with its events; null when the device does not hold it. */
export function useDriveDetail(clientTripId: string): UseQueryResult<{ drive: LocalDrive; events: LocalDriveEvent[] } | null> {
  const { db } = useDataSource();
  return useQuery({
    queryKey: queryKeys.drive(clientTripId),
    queryFn: () => readDriveDetail(db, clientTripId),
    enabled: clientTripId.length > 0,
  });
}

/** Sums over scored, non-not_driving drives since `sinceMs` (null: all time). */
export function useStatSums(sinceMs: number | null): UseQueryResult<StatSums> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.statSums(sinceMs), queryFn: () => readStatSums(db, sinceMs) });
}

/** Scored drives, for the first-run gate (< 3). */
export function useDriveCount(): UseQueryResult<number> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.driveCount(), queryFn: () => readDriveCount(db) });
}

/** The trimmed polylines of the user's own drives (the heat map). */
export function useRoutePolylines(sinceMs: number | null): UseQueryResult<string[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.routes(sinceMs), queryFn: () => readRoutePolylines(db, sinceMs) });
}
