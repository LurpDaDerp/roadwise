/**
 * The local drive data every screen reads (plan §10). Each hook is a namespaced key over a pure
 * reader; the readers are exported so a test can run them against sql.js directly.
 */
import type { StatSums } from '@scoring';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createTripsRepo } from '@/data/db/trips';
import { useDataSource } from '@/data/queries/context';
import { queryKeys, type DriveHistoryFilter } from '@/data/queries/keys';
import {
  isListed,
  isScoredDrive,
  matchesHistoryFilter,
  sumStats,
  toLocalDrive,
  toLocalDriveEvent,
  type LocalDrive,
  type LocalDriveEvent,
} from '@/data/queries/rows';

export type { DriveCounts, DriveStatus, LocalDrive, LocalDriveEvent } from '@/data/queries/rows';

export async function readDrives(db: Db): Promise<LocalDrive[]> {
  const rows = await createTripsRepo(db).list();
  return rows.map(toLocalDrive);
}

export async function readRecentDrives(db: Db, limit: number): Promise<LocalDrive[]> {
  return (await readDrives(db)).filter(isListed).slice(0, Math.max(0, limit));
}

export async function readDriveHistory(db: Db, filter: DriveHistoryFilter): Promise<LocalDrive[]> {
  return (await readDrives(db)).filter((d) => matchesHistoryFilter(d, filter));
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

export async function readStatSums(db: Db, sinceMs: number | null): Promise<StatSums> {
  return sumStats(await readDrives(db), sinceMs);
}

export async function readDriveCount(db: Db): Promise<number> {
  return (await readDrives(db)).filter(isScoredDrive).length;
}

export async function readRoutePolylines(db: Db, sinceMs: number | null): Promise<string[]> {
  return (await readDrives(db))
    .filter((d) => isListed(d) && d.polyline !== null && d.polyline !== '' && (sinceMs === null || d.startedAt >= sinceMs))
    .map((d) => d.polyline as string);
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
