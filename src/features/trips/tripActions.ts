/**
 * The two writes D3 and D5 make, beside Task 6's `setTripRole`: reporting an event, and deleting
 * a drive.
 *
 * Both follow the same shape as the role change, which is the shape everything offline-first in
 * this app follows: **write what the driver just decided to SQLite, queue the request that owes
 * the server, commit both together, then wake the runner.** The screen re-reads from SQLite, so
 * the change is on screen before any network is touched and survives being killed in a tunnel.
 *
 * What is deliberately *not* here: any judgement about whether a report will be accepted. §9.9's
 * allowance (3 per rolling 7 days, ≤ 20 % of scored events over 30 days, a stated posted limit
 * free) is the server's to count. The device writes `outcome: 'queued'` and waits to be told.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import {
  createEventsRepo,
  createQueueRepo,
  createTripsRepo,
  MissingTripError,
  type Db,
  type DisputeReason,
  type DisputeRecord,
  type EventPatch,
  type EventRow,
  type TripPatch,
  type TripRow,
} from '@/data/db';
import { invalidateAfterSync, invalidateTrip, useDb } from '@/data/queries';
import type { SyncKind } from '@/data/sync/kinds';
import { emitQueueChanged } from '@/data/sync/queue';

export const DISPUTE_KIND: SyncKind = 'dispute';
export const DELETE_TRIP_KIND: SyncKind = 'delete-trip';

/**
 * One report per event, for the life of the event. §7.D D3 offers the button once — a report that
 * was recorded but not applied is not re-offered — so a stable key is right: a double tap cannot
 * queue the same report twice, and a retry after a crash sends the same bytes to the same key.
 */
export const disputeIdempotencyKey = (clientEventId: string): string => `dispute:${clientEventId}`;

/** One delete per trip, ever. */
export const deleteIdempotencyKey = (clientTripId: string): string => `delete:${clientTripId}`;

/** The `trip-actions` request body for a report, as Task 2b's function reads it. */
export interface DisputePayload {
  action: 'dispute';
  clientEventId: string;
  reason: DisputeReason;
  note?: string;
  statedLimitMph?: number;
}

/** The `trip-actions` request body for a delete. The queue *kind* is `delete-trip`. */
export interface DeleteTripPayload {
  action: 'delete';
  clientTripId: string;
}

export interface DisputeInput {
  reason: DisputeReason;
  /** Free text, only for "Other" — trimmed, and dropped when empty. */
  note?: string;
  /** The posted limit the driver says is right, only for "The speed limit is wrong". */
  statedLimitMph?: number;
}

/** The server's own bound on a note; the device trims to the same length rather than be refused. */
export const MAX_NOTE = 500;

/**
 * Report an event (§7.D D3).
 *
 * The local write is the optimistic half: the event is marked `disputed` so the timeline stops
 * showing it as a plain deduction, and the record is stored with `outcome: 'queued'` so D3 can
 * say "Reported — sending" rather than pretending the report has landed. The score is **not**
 * touched: the server re-scores the trip and the sync handler writes the new score back, so a
 * number that changed on device and then changed again a second later is avoided.
 */
export async function disputeEvent(
  db: Db,
  clientEventId: string,
  input: DisputeInput,
  now: number = Date.now()
): Promise<EventRow> {
  const note = input.note?.trim().slice(0, MAX_NOTE);
  const record: DisputeRecord = {
    reason: input.reason,
    note: note === undefined || note.length === 0 ? null : note,
    statedLimitMph: input.statedLimitMph ?? null,
    submittedAt: now,
    outcome: 'queued',
    deniedReason: null,
    remainingAllowance: null,
    code: null,
    decidedAt: null,
  };

  const payload: DisputePayload = {
    action: 'dispute',
    clientEventId,
    reason: input.reason,
    ...(record.note === null ? {} : { note: record.note }),
    ...(record.statedLimitMph === null ? {} : { statedLimitMph: record.statedLimitMph }),
  };

  const row = await db.transaction(async (tx) => {
    const events = createEventsRepo(db);
    const current = await events.get(clientEventId);
    if (current === null) throw new MissingEventError(clientEventId);

    const patch: EventPatch = { dispute_json: JSON.stringify(record) };
    // A `possible` event never counted, so nothing about the score changes while the report
    // travels; leaving it `possible` keeps the timeline honest about why it cost nothing.
    if (current.status === 'scored') patch.status = 'disputed';
    const updated = await events.update(clientEventId, patch, tx);
    if (updated === null) throw new MissingEventError(clientEventId);

    await createQueueRepo(db).enqueue(
      DISPUTE_KIND,
      payload,
      disputeIdempotencyKey(clientEventId),
      now,
      tx
    );
    return updated;
  });
  // After the commit, so a listener that drains meets the row and not the lock.
  emitQueueChanged();
  return row;
}

export class MissingEventError extends Error {
  constructor(readonly id: string) {
    super(`event ${id} not found`);
    this.name = 'MissingEventError';
  }
}

/**
 * Delete a drive (§7.D D5).
 *
 * The row is marked `deleted_at` and every read excludes it from that instant — offline included
 * — while the queued `delete-trip` owes the server the same. The row itself is kept until the
 * queue drains: it is what the runner reads to decide that a trace still waiting for Wi-Fi is no
 * longer worth uploading, and what stops a second delete being queued for a trip already gone.
 */
export async function deleteTrip(
  db: Db,
  clientTripId: string,
  now: number = Date.now()
): Promise<TripRow> {
  const payload: DeleteTripPayload = { action: 'delete', clientTripId };

  const row = await db.transaction(async (tx) => {
    const trips = createTripsRepo(db);
    const current = await trips.get(clientTripId, tx);
    if (current === null) throw new MissingTripError(clientTripId);

    const updated = await trips.update(clientTripId, { deleted_at: now } satisfies TripPatch, now, tx);
    if (updated === null) throw new MissingTripError(clientTripId);

    await createQueueRepo(db).enqueue(
      DELETE_TRIP_KIND,
      payload,
      deleteIdempotencyKey(clientTripId),
      now,
      tx
    );
    return updated;
  });
  emitQueueChanged();
  return row;
}

type Phase = 'idle' | 'busy' | 'done' | 'error';

export interface ReportEvent {
  report(clientEventId: string, input: DisputeInput): Promise<boolean>;
  phase: Phase;
}

/** D3's hook: write the report, then refresh every query the trip appears in. */
export function useReportEvent(clientTripId: string): ReportEvent {
  const db = useDb();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');

  const report = useCallback(
    async (clientEventId: string, input: DisputeInput) => {
      setPhase('busy');
      try {
        await disputeEvent(db, clientEventId, input);
        await invalidateTrip(queryClient, clientTripId);
        setPhase('done');
        return true;
      } catch {
        setPhase('error');
        return false;
      }
    },
    [db, queryClient, clientTripId]
  );

  return { report, phase };
}

export interface DeleteTrip {
  remove(clientTripId: string): Promise<boolean>;
  phase: Phase;
}

/**
 * D5's delete. The whole cache is invalidated rather than the one trip: the drive vanishes from
 * the history, from the day strip and from every insight at once, and the screen that called
 * this is about to leave anyway.
 */
export function useDeleteTrip(): DeleteTrip {
  const db = useDb();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');

  const remove = useCallback(
    async (clientTripId: string) => {
      setPhase('busy');
      try {
        await deleteTrip(db, clientTripId);
        await invalidateAfterSync(queryClient);
        setPhase('done');
        return true;
      } catch {
        setPhase('error');
        return false;
      }
    },
    [db, queryClient]
  );

  return { remove, phase };
}
