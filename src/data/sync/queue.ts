import { z } from 'zod';

import type { Db } from '@/data/db/driver';
import { createQueueRepo } from '@/data/db/queue';
import { createSettingsRepo } from '@/data/db/settings';
import type { QueueItem } from '@/data/db/types';
import { type SyncKind } from '@/data/sync/kinds';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload } from '@/data/sync/payload';

/** The queue `kind` the sync runner maps to `POST /functions/v1/finalize-trip`. */
export const FINALIZE_KIND: SyncKind = 'finalize-trip';

/** The queue `kind` for a trace the device owes Storage after the summary has already gone up. */
export const TRACE_UPLOAD_KIND: SyncKind = 'trace-upload';

/**
 * Deterministic per trip — not a fresh uuid — so a finalize retried after a failure cannot queue
 * the same trip twice, and the server dedupes the upload on the same key.
 */
export const finalizeIdempotencyKey = (clientTripId: string): string => `trip:${clientTripId}`;

/**
 * The trace's own key, distinct from the trip's so both items can be in the queue at once: on
 * cellular the summary goes up under `trip:<id>` while the file waits under `trace:<id>`.
 */
export const traceIdempotencyKey = (clientTripId: string): string => `trace:${clientTripId}`;

/**
 * Where the last signed-in user's id is kept, so work queued between drains can be stamped with
 * its owner. The sync runner writes it whenever it reads a session; nothing else does.
 *
 * It is a *record of who queued this*, never an authorisation: every request still travels under
 * the live session's own token, and the server scopes every lookup to that token's user. What the
 * stamp buys is the refusal — an item queued by one user is never posted under another's session
 * (one device, one database, and `signOut` clears neither).
 */
export const SESSION_UID_KEY = 'session.uid';

/**
 * The bootstrap's record of whose device this is (`src/boot/device.ts`), read here as a fallback.
 *
 * It is written on the identity stage of every launch and every handover, which is *before* any
 * drive can be recorded; `SESSION_UID_KEY` is written by the runner's first pass, which may come
 * after. Without the fallback, work queued between a sign-in and the next drain would be
 * unowned — and unowned work is refused, so it would be lost rather than merely unattributed.
 */
export const DEVICE_OWNER_KEY = 'device.lastUserId';

/** The owner to stamp on work queued now, or null when this device has never had a user. */
export async function currentOwnerUid(db: Db): Promise<string | null> {
  const settings = createSettingsRepo(db);
  return (
    (await settings.get<string>(SESSION_UID_KEY)) ??
    (await settings.get<string>(DEVICE_OWNER_KEY))
  );
}

/**
 * The characters a `client_trip_id` may contain — the server's own rule, enforced here too.
 *
 * Defence in depth: the id is embedded in a Storage object key and in a local file path, and while
 * the bucket policy confines a write to `<uid>/` and the function refuses anything else, neither
 * protects the device's own filesystem from a `../` that somehow reached the queue.
 */
export const CLIENT_TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a deferred trace upload needs, and nothing more: the object key is derived from the
 * signed-in user and the trip id at upload time, never from anything stored here (§4.7).
 */
export const TraceUploadPayloadSchema = z
  .object({
    clientTripId: z.string().regex(CLIENT_TRIP_ID),
    /** The local file, relative to the traces directory: `<clientTripId>.bin.gz`. */
    tracePath: z.string().min(1).max(256),
  })
  .strict()
  .refine((p) => p.tracePath === `${p.clientTripId}.bin.gz`, {
    error: 'tracePath must be <clientTripId>.bin.gz',
    path: ['tracePath'],
  });

export type TraceUploadPayload = z.infer<typeof TraceUploadPayloadSchema>;

// The `queue:changed` emitter. The sync runner subscribes in `start()` so a trip queued while
// the app is open uploads at once instead of waiting for the next foreground.
//
// Listeners are called on a macrotask rather than inline, because the one caller that matters —
// `finalizeTrip` — enqueues inside the transaction that also writes the trip row. Waking a drain
// inside that transaction would have it meet SQLite's write lock (or, under sql.js, an illegal
// nested BEGIN); by the time a `setTimeout(0)` runs, the transaction has committed and the row
// the runner is about to read is there. Nothing is scheduled while no one is listening.
type QueueChangedListener = () => void;

const queueChangedListeners = new Set<QueueChangedListener>();
let queueChangedScheduled = false;

/** Subscribe to "something was queued"; the returned function unsubscribes. */
export function onQueueChanged(listener: QueueChangedListener): () => void {
  queueChangedListeners.add(listener);
  return () => {
    queueChangedListeners.delete(listener);
  };
}

/** Wake every listener once, after the current transaction has had its chance to commit. */
export function emitQueueChanged(): void {
  if (queueChangedScheduled || queueChangedListeners.size === 0) return;
  queueChangedScheduled = true;
  setTimeout(() => {
    queueChangedScheduled = false;
    for (const listener of [...queueChangedListeners]) listener();
  }, 0);
}

// `sync:applied`: a drain pass has finished and at least one item was settled — a trip is now
// `synced` or `failed`, and a day row may have landed in `score_daily_cache`. This is the precise
// signal for the query hooks: it carries the counts and fires only on a pass that changed
// something. (The runner also re-emits `queue:changed` on such a pass, since the queue genuinely
// did change and that is what a subscriber wired to "the sync queue" already listens to.)
//
// Fired synchronously at the end of the pass, once every write has committed and no transaction is
// open, so a listener sees the settled rows. Each listener is guarded: one that throws must not
// fail the drain that told it the good news.
export type SyncApplied = Readonly<{ done: number; failed: number; deferred: number }>;

type SyncAppliedListener = (result: SyncApplied) => void;

const syncAppliedListeners = new Set<SyncAppliedListener>();

/** Subscribe to "a pass settled something"; the returned function unsubscribes. */
export function onSyncApplied(listener: SyncAppliedListener): () => void {
  syncAppliedListeners.add(listener);
  return () => {
    syncAppliedListeners.delete(listener);
  };
}

export function emitSyncApplied(result: SyncApplied, onError?: (error: unknown) => void): void {
  for (const listener of [...syncAppliedListeners]) {
    try {
      listener(result);
    } catch (error) {
      onError?.(error);
    }
  }
}

/**
 * Validate the payload against the contract, then queue it. Idempotent: a trip already in the
 * queue keeps its first item, whatever state it has reached. Given a transaction handle `on`,
 * the queue item joins that transaction.
 */
export async function enqueueFinalize(
  db: Db,
  payload: FinalizeTripPayload,
  now: number = Date.now(),
  on?: Db
): Promise<QueueItem> {
  const valid = FinalizeTripPayloadSchema.parse(payload);
  const owner = await currentOwnerUid(db);
  const item = await createQueueRepo(db).enqueue(
    FINALIZE_KIND,
    valid,
    finalizeIdempotencyKey(valid.clientTripId),
    now,
    on,
    owner
  );
  emitQueueChanged();
  return item;
}

/**
 * Queue a trace the runner chose not to upload with its trip — cellular, with
 * `sync.wifiOnlyTraces` on. Idempotent on `trace:<clientTripId>`, so a finalize item retried
 * before the trace goes up does not queue a second one.
 */
export async function enqueueTraceUpload(
  db: Db,
  payload: TraceUploadPayload,
  now: number = Date.now(),
  on?: Db
): Promise<QueueItem> {
  const valid = TraceUploadPayloadSchema.parse(payload);
  const owner = await currentOwnerUid(db);
  const item = await createQueueRepo(db).enqueue(
    TRACE_UPLOAD_KIND,
    valid,
    traceIdempotencyKey(valid.clientTripId),
    now,
    on,
    owner
  );
  emitQueueChanged();
  return item;
}

/**
 * The payload queued for a trip, in whatever state the item has reached, or null when the trip
 * was never queued (or its finished item has been purged). This is how a re-run finalize returns
 * what the first run produced.
 */
export async function findFinalize(
  db: Db,
  clientTripId: string
): Promise<FinalizeTripPayload | null> {
  const item = await createQueueRepo(db).byKey(finalizeIdempotencyKey(clientTripId));
  return item ? FinalizeTripPayloadSchema.parse(JSON.parse(item.payload_json)) : null;
}
