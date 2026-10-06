/**
 * The two things a user may do to a stored drive (plan §4, §10): report one event, or mark the
 * drive as "wasn't driving". Both update the local rows optimistically to `pending`, queue the
 * request to `trip-actions`, and let the runner resolve them to the server's answer.
 */
import type { QueryClient } from '@tanstack/react-query';

import { createEventsRepo, createTripsRepo, type Db, type DisputeReason } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import { invalidateDrive } from '@/data/queries/invalidate';
import { enqueueAction } from '@/data/sync/queue';

export interface DriveActionDeps {
  db: Db;
  /** Invalidated after the local write (drive queries + server summary); optional in tests. */
  queryClient?: QueryClient;
  now?: () => number;
}

/** The server summary's cache root (`src/data/server/useServerQuery.ts`), without importing the client. */
const invalidateServer = (qc: QueryClient): Promise<void> => qc.invalidateQueries({ queryKey: ['server'] });

export type ReportOutcome = 'queued' | 'already' | 'missing';

/** Report an event with one of the reason sheet's reasons. */
export async function reportEvent(clientTripId: string, eventId: string, reason: DisputeReason, deps: DriveActionDeps): Promise<ReportOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const events = createEventsRepo(db);
  const event = await events.get(eventId);
  if (event === null || event.client_trip_id !== clientTripId) return 'missing';
  if (event.dispute_status !== 'none') return 'already';
  await db.transaction(async (tx) => {
    await events.update(eventId, { dispute_status: 'pending', dispute_reason: reason, dispute_message: null }, tx);
    await enqueueAction(db, { action: 'dispute', clientTripId, eventId, reason }, now(), tx);
  });
  emitDataChanged({ source: 'enqueue' });
  if (deps.queryClient) {
    await invalidateDrive(deps.queryClient, clientTripId);
    void invalidateServer(deps.queryClient);
  }
  return 'queued';
}

export type NotDrivingOutcome = 'queued' | 'already' | 'missing';

/** "Wasn't driving": the drive's gains and penalties are taken back by the server. */
export async function markNotDriving(clientTripId: string, deps: DriveActionDeps): Promise<NotDrivingOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const trips = createTripsRepo(db);
  const trip = await trips.get(clientTripId);
  if (trip === null) return 'missing';
  if (trip.status === 'not_driving') return 'already';
  await db.transaction(async (tx) => {
    await trips.update(clientTripId, { status: 'not_driving', points_net: 0 }, now(), tx);
    await enqueueAction(db, { action: 'not_driving', clientTripId, previousStatus: trip.status }, now(), tx);
  });
  emitDataChanged({ source: 'enqueue' });
  if (deps.queryClient) {
    await invalidateDrive(deps.queryClient, clientTripId);
    void invalidateServer(deps.queryClient);
  }
  return 'queued';
}
