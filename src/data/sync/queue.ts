import type { Db } from '@/data/db/driver';
import { createQueueRepo } from '@/data/db/queue';
import type { QueueItem } from '@/data/db/types';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload } from '@/data/sync/payload';

/** The queue `kind` the sync runner maps to `POST /functions/v1/finalize-trip`. */
export const FINALIZE_KIND = 'finalize-trip';

/**
 * Deterministic per trip — not a fresh uuid — so a finalize retried after a crash cannot queue
 * the same trip twice, and the server dedupes the upload on the same key.
 */
export const finalizeIdempotencyKey = (clientTripId: string): string => `trip:${clientTripId}`;

/**
 * Validate the payload against the contract, then queue it. Idempotent: a trip already in the
 * queue keeps its first item, whatever state it has reached.
 */
export async function enqueueFinalize(
  db: Db,
  payload: FinalizeTripPayload,
  now: number = Date.now()
): Promise<QueueItem> {
  const valid = FinalizeTripPayloadSchema.parse(payload);
  return createQueueRepo(db).enqueue(
    FINALIZE_KIND,
    valid,
    finalizeIdempotencyKey(valid.clientTripId),
    now
  );
}

/**
 * The payload queued for a trip, in whatever state the item has reached, or null when the trip
 * was never queued. This is how a re-run finalize returns what the first run produced.
 */
export async function findFinalize(
  db: Db,
  clientTripId: string
): Promise<FinalizeTripPayload | null> {
  const { rows } = await db.execute(
    'SELECT payload_json FROM sync_queue WHERE idempotency_key = ?',
    [finalizeIdempotencyKey(clientTripId)]
  );
  const json = rows[0]?.payload_json;
  return typeof json === 'string' ? FinalizeTripPayloadSchema.parse(JSON.parse(json)) : null;
}
