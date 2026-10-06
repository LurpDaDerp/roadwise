import { z } from 'zod';

import type { Db } from '@/data/db/driver';
import { createQueueRepo } from '@/data/db/queue';
import { createSettingsRepo } from '@/data/db/settings';
import type { QueueItem } from '@/data/db/types';
import { emitDataChanged } from '@/data/events';
import type { SyncKind } from '@/data/sync/kinds';
import { FinalizeTripPayloadV3Schema, type FinalizeTripPayloadV3 } from '@/data/sync/payload';

export const FINALIZE_KIND: SyncKind = 'finalize-trip';
export const ACTIONS_KIND: SyncKind = 'trip-actions';

/** Deterministic per trip, so a finalize retried after a failure cannot queue the same trip twice. */
export const finalizeIdempotencyKey = (clientTripId: string): string => `trip:${clientTripId}`;
export const disputeIdempotencyKey = (eventId: string): string => `dispute:${eventId}`;
export const notDrivingIdempotencyKey = (clientTripId: string): string => `not_driving:${clientTripId}`;

/**
 * Where the last signed-in user's id is kept, so work queued between drains can be stamped with
 * its owner. A *record of who queued this*, never an authorisation: every request still travels
 * under the live session's own token, and an item queued by one user is never posted under another's.
 */
export const SESSION_UID_KEY = 'session.uid';
/** The bootstrap's record of whose device this is (`src/boot/device.ts`), the first choice. */
export const DEVICE_OWNER_KEY = 'device.lastUserId';

/** The owner to stamp on work queued now, or null when this device has never had a user. */
export async function currentOwnerUid(db: Db): Promise<string | null> {
  const settings = createSettingsRepo(db);
  return (await settings.get<string>(DEVICE_OWNER_KEY)) ?? (await settings.get<string>(SESSION_UID_KEY));
}

/**
 * Whether the device's recorded owner is `uid`, read on `on` (a transaction handle). The fence
 * every writer that crossed a network round trip uses before it commits: a reply that arrives for
 * the previous owner finds a different uid here and writes nothing.
 */
export async function deviceOwnerIs(on: Db, uid: string): Promise<boolean> {
  const { rows } = await on.execute('SELECT value_json FROM settings WHERE key = ?', [DEVICE_OWNER_KEY]);
  const raw = rows[0]?.value_json;
  if (typeof raw !== 'string') return false;
  try {
    return JSON.parse(raw) === uid;
  } catch {
    return false;
  }
}

/** The `trip-actions` request bodies (mirrors `supabase/functions/trip-actions/schema.ts`). */
export const DisputeActionSchema = z
  .object({
    action: z.literal('dispute'),
    clientTripId: z.uuid(),
    eventId: z.uuid(),
    reason: z.enum(['hazard', 'wrong_limit', 'mounted']),
  })
  .strict();
export const NotDrivingActionSchema = z
  .object({
    action: z.literal('not_driving'),
    clientTripId: z.uuid(),
    /** The local status to restore when the server refuses. Device-only; stripped before the post. */
    previousStatus: z.string().optional(),
  })
  .strict();
export const TripActionSchema = z.discriminatedUnion('action', [DisputeActionSchema, NotDrivingActionSchema]);
export type TripAction = z.infer<typeof TripActionSchema>;

/**
 * Validate the payload against the contract, then queue it. Idempotent on the trip. Given a
 * transaction handle `on`, the queue item joins that transaction.
 */
export async function enqueueFinalize(db: Db, payload: FinalizeTripPayloadV3, now: number = Date.now(), on?: Db): Promise<QueueItem> {
  const valid = FinalizeTripPayloadV3Schema.parse(payload);
  const owner = await currentOwnerUid(db);
  const item = await createQueueRepo(db).enqueue(FINALIZE_KIND, valid, finalizeIdempotencyKey(valid.clientTripId), now, on, owner);
  // Delivered on a macrotask, so a drain it wakes meets the committed row, not the lock.
  emitDataChanged({ source: 'enqueue' });
  return item;
}

export async function enqueueAction(db: Db, action: TripAction, now: number = Date.now(), on?: Db): Promise<QueueItem> {
  const valid = TripActionSchema.parse(action);
  const key = valid.action === 'dispute' ? disputeIdempotencyKey(valid.eventId) : notDrivingIdempotencyKey(valid.clientTripId);
  const owner = await currentOwnerUid(db);
  const item = await createQueueRepo(db).enqueue(ACTIONS_KIND, valid, key, now, on, owner);
  emitDataChanged({ source: 'enqueue' });
  return item;
}

/** The payload queued for a trip, in whatever state the item has reached, or null. */
export async function findFinalize(db: Db, clientTripId: string): Promise<FinalizeTripPayloadV3 | null> {
  const item = await createQueueRepo(db).byKey(finalizeIdempotencyKey(clientTripId));
  if (!item) return null;
  const parsed = FinalizeTripPayloadV3Schema.safeParse(JSON.parse(item.payload_json));
  return parsed.success ? parsed.data : null;
}
