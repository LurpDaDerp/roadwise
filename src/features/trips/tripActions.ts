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
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import {
  createEventsRepo,
  createQueueRepo,
  createSamplesRepo,
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
import { DisputePayloadSchema } from '@/data/sync/actions';
import type { SyncKind } from '@/data/sync/kinds';
import {
  currentOwnerUid,
  emitQueueChanged,
  finalizeIdempotencyKey,
  traceIdempotencyKey,
} from '@/data/sync/queue';
import type { TraceFs } from '@/data/sync/runner';
import { createExpoTraceFs } from '@/data/sync/traceFs';

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

  // Validated here rather than only on the way out: a body the runner cannot send would be a
  // terminal failure hours later, with the driver looking at "Reported — sending" in the
  // meantime. Refusing at the tap is the only place they can do anything about it.
  const payload: DisputePayload = {
    action: 'dispute',
    clientEventId,
    reason: input.reason,
    ...(record.note === null ? {} : { note: record.note }),
    ...(record.statedLimitMph === null ? {} : { statedLimitMph: record.statedLimitMph }),
  };
  DisputePayloadSchema.parse(payload);

  const owner = await currentOwnerUid(db);
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

    const queue = createQueueRepo(db);
    const key = disputeIdempotencyKey(clientEventId);
    await queue.enqueue(DISPUTE_KIND, payload, key, now, tx, owner);
    // A report that never left leaves a `failed` item behind, and `INSERT OR IGNORE` would drop
    // the second attempt on the floor. Sending it again means putting that item back in the
    // queue **with the answer the driver just gave**: the key is the same work, not the same
    // words, and the stored record already holds the new reason.
    await queue.reopen(key, now, tx, payload);
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

/** A drive's trace on disk, as the finalizer wrote it and the runner reads it. */
const tracePathFor = (clientTripId: string): string => `${clientTripId}.bin.gz`;

/**
 * Remove a drive's trace file. Best effort and silent: a file that will not delete is disk to
 * reclaim, not a reason to refuse the delete the driver just confirmed. `fs` is injectable so a
 * test never loads the native file-system module.
 */
async function removeTraceFile(clientTripId: string, fs?: TraceFs): Promise<void> {
  try {
    const target = fs ?? (await createExpoTraceFs());
    await target.remove(tracePathFor(clientTripId));
  } catch {
    // Nothing to do about it, and nothing about the delete depends on it.
  }
}

export interface DeleteTripDeps {
  /** The traces directory. Defaults to the device's; a test passes its own. */
  fs?: TraceFs;
}

/**
 * Delete a drive (§7.D D5).
 *
 * D5's copy says the drive "goes for good", so **everything that identifies it goes now**: the
 * trace file — a second-by-second record of where the driver went, and the most identifying thing
 * this app holds — the route polyline, the endpoint labels and geohashes, every event with its
 * coordinates, and the 1 Hz samples. A trace still queued for Wi-Fi is dropped with them, so
 * nothing about the drive can reach Storage after this point.
 *
 * What is left is a husk: a hidden row carrying its id, its `deleted_at` and the sync bookkeeping,
 * because the server still has to be told and the queue item is the only thing that will tell it.
 * `runDeleteTrip` removes that row too once the server confirms. Every read already excludes it
 * (`isHiddenTrip`, `readTrip`), so the drive is gone from the app the instant this returns —
 * offline included.
 */
export async function deleteTrip(
  db: Db,
  clientTripId: string,
  now: number = Date.now(),
  deps: DeleteTripDeps = {}
): Promise<TripRow> {
  const payload: DeleteTripPayload = { action: 'delete', clientTripId };
  const owner = await currentOwnerUid(db);

  const row = await db.transaction(async (tx) => {
    const trips = createTripsRepo(db);
    const current = await trips.get(clientTripId, tx);
    if (current === null) throw new MissingTripError(clientTripId);

    const updated = await trips.update(
      clientTripId,
      {
        deleted_at: now,
        polyline: null,
        start_label: null,
        end_label: null,
        start_geohash5: null,
        end_geohash5: null,
      } satisfies TripPatch,
      now,
      tx
    );
    if (updated === null) throw new MissingTripError(clientTripId);

    await createEventsRepo(db).removeByTrip(clientTripId, tx);
    await createSamplesRepo(db).purgeByTrip(clientTripId, tx);

    const queue = createQueueRepo(db);
    // Nothing queued about this drive may outlive it. The trace item has nothing left to upload
    // for; the finalize item is worse — its stored body *is* the drive, polyline, endpoint
    // geohashes and every event coordinate, so leaving it would keep the route the delete was
    // supposed to destroy. `runFinalize` would refuse to send it anyway (`tripIsGone`), which
    // means dropping it costs nothing and keeps nothing.
    await queue.dropByKey(traceIdempotencyKey(clientTripId), tx);
    await queue.dropByKey(finalizeIdempotencyKey(clientTripId), tx);
    await queue.enqueue(
      DELETE_TRIP_KIND,
      payload,
      deleteIdempotencyKey(clientTripId),
      now,
      tx,
      owner
    );
    await queue.reopen(deleteIdempotencyKey(clientTripId), now, tx);
    return updated;
  });

  // Outside the transaction: the file system is not in it, and a delete that committed must not
  // be undone by a file that would not go.
  await removeTraceFile(clientTripId, deps.fs);
  emitQueueChanged();
  return row;
}

/**
 * The drives the device has deleted and the server has not been told about.
 *
 * Read from the **queue**, not from the trip rows: a `failed` `delete-trip` item is precisely
 * "the delete gave up", where `trips.sync_error` is also set by an upload refusal that had
 * nothing to do with a delete, and would put a banner about deleting in front of a driver whose
 * delete is still on its way.
 */
export async function readFailedDeletes(db: Db): Promise<string[]> {
  const items = await createQueueRepo(db).listFailed(DELETE_TRIP_KIND);
  const ids: string[] = [];
  for (const item of items) {
    try {
      const body = JSON.parse(item.payload_json) as { clientTripId?: unknown };
      if (typeof body.clientTripId === 'string') ids.push(body.clientTripId);
    } catch {
      // A body this build cannot read names no drive; the queue row is still the record.
    }
  }
  return ids;
}

/** Put every given-up delete back in the queue, for the driver's "Try again". */
export async function retryFailedDeletes(
  db: Db,
  clientTripIds: readonly string[],
  now: number = Date.now()
): Promise<void> {
  const queue = createQueueRepo(db);
  const trips = createTripsRepo(db);
  for (const id of clientTripIds) {
    await trips.update(id, { sync_error: null, sync_state: 'queued' } satisfies TripPatch, now);
    await queue.reopen(deleteIdempotencyKey(id), now);
  }
  emitQueueChanged();
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

export interface FailedDeletes {
  /** The client ids of drives deleted here that the server has not been told about. */
  ids: string[];
  retry(): Promise<void>;
  busy: boolean;
}

/**
 * D4's read of the deletes that gave up. Keyed under the `trips` root so every invalidation that
 * refreshes the history refreshes this too.
 */
export function useFailedDeletes(): FailedDeletes {
  const db = useDb();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const query: UseQueryResult<string[]> = useQuery({
    queryKey: ['trips', 'failed-deletes'],
    queryFn: () => readFailedDeletes(db),
  });
  const ids = useMemo(() => query.data ?? [], [query.data]);

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      await retryFailedDeletes(db, ids);
      await invalidateAfterSync(queryClient);
    } finally {
      setBusy(false);
    }
  }, [db, queryClient, ids]);

  return { ids, retry, busy };
}
