/**
 * The local drive data every screen reads (plan §10). Each hook is a namespaced key over a pure
 * reader; the readers are exported so a test can run them against sql.js directly.
 *
 * Every reader asks SQLite for only what it shows: a count is a COUNT, the recent drives a LIMIT,
 * a sum reads the summed columns, and a list leaves each drive's stored server answer unread. The
 * rows, their order and every number are those of filtering the whole table.
 *
 * A drive archived 183 days after it ended (`@/data/db/archive`) is a stat, never a list item: the
 * lists (recent drives, history) and a drive's own read (its recap) leave it out, while the sums
 * and the count still count it, and the all-time routes take its line from the route pool.
 */
import type { StatSums } from '@scoring';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { createRoutePoolRepo } from '@/data/db/archive';
import type { Db } from '@/data/db/driver';
import { createEventsRepo, toEventRow } from '@/data/db/events';
import { asEnum, asNumber, asNumberOrNull, asTextOrNull } from '@/data/db/row';
import { createTripsRepo } from '@/data/db/trips';
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
  TRIP_VIEW,
  toTripView,
} from '@/data/queries/rows';

export type { DriveCounts, DriveStatus, LocalDrive, LocalDriveEvent } from '@/data/queries/rows';

export async function readDrives(db: Db): Promise<LocalDrive[]> {
  const rows = await createTripsRepo(db).list();
  return rows.map(toLocalDrive);
}

/** The order every list reads in (`trips.list`). */
const NEWEST_FIRST = 'ORDER BY t.started_at DESC, t.client_trip_id ASC';

/** The drives a list shows: not recording, not archived (`isListed`). */
const LISTED = "t.status != 'recording' AND t.archived_at IS NULL";

export async function readRecentDrives(db: Db, limit: number): Promise<LocalDrive[]> {
  const { rows } = await db.execute(`SELECT ${TRIP_VIEW} FROM trips t WHERE ${LISTED} ${NEWEST_FIRST} LIMIT ?`, [Math.max(0, limit)]);
  return rows.map((row) => toLocalDrive(toTripView(row)));
}

export async function readDriveHistory(db: Db, filter: DriveHistoryFilter): Promise<LocalDrive[]> {
  const { rows } = await db.execute(`SELECT ${TRIP_VIEW} FROM trips t WHERE ${LISTED} ${NEWEST_FIRST}`);
  return rows.map((row) => toListedDrive(toTripView(row))).filter((d) => matchesHistoryFilter(d, filter));
}

/**
 * The events of each of `clientTripIds` in one read, oldest first per drive (`listByTrip`'s order).
 * Every id asked for is in the answer, a drive with none under an empty list.
 */
export async function readDriveEvents(db: Db, clientTripIds: readonly string[]): Promise<ReadonlyMap<string, LocalDriveEvent[]>> {
  const out = new Map<string, LocalDriveEvent[]>(clientTripIds.map((id) => [id, []]));
  if (clientTripIds.length === 0) return out;
  const { rows } = await db.execute(
    `SELECT * FROM trip_events WHERE client_trip_id IN (SELECT value FROM json_each(?)) ORDER BY client_trip_id ASC, started_at ASC, id ASC`,
    [JSON.stringify(clientTripIds)]
  );
  for (const row of rows) {
    const event = toEventRow(row);
    out.get(event.client_trip_id)?.push(toLocalDriveEvent(event));
  }
  return out;
}

/** One drive with its events; null when the device does not hold it, or holds it archived (no recap). */
export async function readDriveDetail(
  db: Db,
  clientTripId: string
): Promise<{ drive: LocalDrive; events: LocalDriveEvent[] } | null> {
  const { rows } = await db.execute(`SELECT ${TRIP_VIEW} FROM trips t WHERE t.client_trip_id = ?`, [clientTripId]);
  const row = rows[0] === undefined ? null : toTripView(rows[0]);
  if (row === null || row.archived_at !== null) return null;
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

/**
 * The routes of the drives started at or after `sinceMs`, newest first, each as the driver's own
 * views draw it (the whole route where the phone holds it, else the trimmed one, as `toLocalDrive`);
 * all time (null) adds the route pool's lines after them (they carry no date, so a window never
 * holds them).
 */
export async function readRoutePolylines(db: Db, sinceMs: number | null): Promise<string[]> {
  const since = sinceMs === null ? '' : 'AND t.started_at >= ?';
  const { rows } = await db.execute(
    `SELECT COALESCE(t.route_full, t.polyline) AS line FROM trips t
     WHERE t.status != 'recording' AND COALESCE(t.route_full, t.polyline) IS NOT NULL AND COALESCE(t.route_full, t.polyline) != '' ${since} ${NEWEST_FIRST}`,
    sinceMs === null ? [] : [sinceMs]
  );
  const lines = rows.map((row) => asTextOrNull(row, 'line') ?? '');
  return sinceMs === null ? [...lines, ...(await readRoutePool(db))] : lines;
}

/** The route pool: the archived scored drives' routes, lines with no drive and no date. */
export function readRoutePool(db: Db): Promise<string[]> {
  return createRoutePoolRepo(db).list();
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

/** One drive with its events; null when the device does not hold it, or holds it archived. */
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

/** The routes of the user's own drives as their own views draw them; all time adds the route pool. */
export function useRoutePolylines(sinceMs: number | null): UseQueryResult<string[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.routes(sinceMs), queryFn: () => readRoutePolylines(db, sinceMs) });
}

/** The route pool's lines (the All trips map draws them beside the drives' own routes). */
export function useRoutePool(): UseQueryResult<string[]> {
  const { db } = useDataSource();
  return useQuery({ queryKey: queryKeys.routePool(), queryFn: () => readRoutePool(db), placeholderData: keepPreviousData });
}
