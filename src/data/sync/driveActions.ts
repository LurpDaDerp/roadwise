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
  /** Drive queries are invalidated after the local write; optional in tests. The server summary
   *  refetches when the runner settles the action (`sync` change), not here: the server doesn't
   *  know anything yet. */
  queryClient?: QueryClient;
  now?: () => number;
}

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
  if (deps.queryClient) await invalidateDrive(deps.queryClient, clientTripId);
  return 'queued';
}

export type NotDrivingOutcome = 'queued' | 'already' | 'missing';

/** "Wasn't driving": the drive leaves the Safety Rating and the week's goals once the server agrees. */
export async function markNotDriving(clientTripId: string, deps: DriveActionDeps): Promise<NotDrivingOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const trips = createTripsRepo(db);
  const trip = await trips.get(clientTripId);
  if (trip === null) return 'missing';
  if (trip.status === 'not_driving') return 'already';
  await db.transaction(async (tx) => {
    await trips.update(clientTripId, { status: 'not_driving' }, now(), tx);
    await enqueueAction(db, { action: 'not_driving', clientTripId, previousStatus: trip.status }, now(), tx);
  });
  emitDataChanged({ source: 'enqueue' });
  if (deps.queryClient) await invalidateDrive(deps.queryClient, clientTripId);
  return 'queued';
}
