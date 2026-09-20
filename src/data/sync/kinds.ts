/**
 * Every kind of work the outbox carries.
 *
 * `sync_queue.kind` is a plain TEXT column with no CHECK — the enum lives here instead, so the
 * enqueue sites and the runner's dispatch read from one list and a kind that is added without a
 * handler is a type error rather than an item that sits in the queue forever.
 *
 * - `finalize-trip` — a finished trip: its trace to Storage, then `POST finalize-trip` (§4.4).
 * - `trace-upload` — that trip's trace alone, deferred because the device was on cellular and
 *   `sync.wifiOnlyTraces` was on. The summary has already gone up without it.
 * - `dispute`, `set-role`, `delete-trip` — the three `trip-actions` calls (§4.5). M2 Task 3
 *   ships no handler for them; the runner leaves such an item alone rather than failing it, so
 *   an app that queues one before its handler lands loses nothing.
 */
export const SYNC_KINDS = [
  'finalize-trip',
  'trace-upload',
  'dispute',
  'set-role',
  'delete-trip',
] as const;

export type SyncKind = (typeof SYNC_KINDS)[number];

export const isSyncKind = (value: string): value is SyncKind =>
  (SYNC_KINDS as readonly string[]).includes(value);
