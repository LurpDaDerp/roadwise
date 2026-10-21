/**
 * The two things a user may do to a stored drive (plan §4, §10): report one event, or mark the
 * drive as "wasn't driving". Both update the local rows optimistically to `pending`, queue the
 * request to `trip-actions`, and let the runner resolve them to the server's answer. A drive still
 * in its 5-minute upload hold uploads at once, ahead of the action (the server must hold the drive
 * before it can act on it; acting on the recap rules out a continuation).
 */
import type { QueryClient } from '@tanstack/react-query';

import { createEventsRepo, createTripsRepo, type Db, type DisputeReason } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import { invalidateDrive } from '@/data/queries/invalidate';
import { createQueueRepo } from '@/data/db/queue';
import { enqueueAction, finalizeIdempotencyKey } from '@/data/sync/queue';

export interface DriveActionDeps {
  db: Db;
  /** Drive queries are invalidated after the local write; optional in tests. The server summary
   *  refetches when the runner settles the action (`sync` change), not here: the server doesn't
   *  know anything yet. */
  queryClient?: QueryClient;
  now?: () => number;
}

export type ReportOutcome = 'queued' | 'already' | 'missing';

/**
 * Report an event with one of the reason sheet's reasons. "My phone was mounted" (`mounted`) is a
 * phone pickup's only: on any other event there is nothing it could report (`missing`).
 */
export async function reportEvent(clientTripId: string, eventId: string, reason: DisputeReason, deps: DriveActionDeps): Promise<ReportOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const events = createEventsRepo(db);
  const event = await events.get(eventId);
  if (event === null || event.client_trip_id !== clientTripId) return 'missing';
  if (reason === 'mounted' && event.type !== 'phone_pickup') return 'missing';
  if (event.dispute_status !== 'none') return 'already';
  const at = now();
  await db.transaction(async (tx) => {
    await events.update(eventId, { dispute_status: 'pending', dispute_reason: reason, dispute_message: null }, tx);
    // The drive's held upload goes first (the same due time, queued earlier).
    await createQueueRepo(db).makeDue(finalizeIdempotencyKey(clientTripId), at, tx);
    await enqueueAction(db, { action: 'dispute', clientTripId, eventId, reason }, at, tx);
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
  const at = now();
  await db.transaction(async (tx) => {
    await trips.update(clientTripId, { status: 'not_driving' }, at, tx);
    // The drive's held upload goes first (the same due time, queued earlier).
    await createQueueRepo(db).makeDue(finalizeIdempotencyKey(clientTripId), at, tx);
    await enqueueAction(db, { action: 'not_driving', clientTripId, previousStatus: trip.status }, at, tx);
  });
  emitDataChanged({ source: 'enqueue' });
  if (deps.queryClient) await invalidateDrive(deps.queryClient, clientTripId);
  return 'queued';
}
