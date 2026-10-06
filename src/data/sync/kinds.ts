/**
 * Every kind of work the outbox carries. `sync_queue.kind` is a plain TEXT column; the enum lives
 * here so the enqueue sites and the runner's dispatch read one list.
 *
 * - `finalize-trip` — a finished drive: `POST finalize-trip` with its v3 payload (plan §3).
 * - `trip-actions` — a dispute or "wasn't driving" (plan §4).
 */
export const SYNC_KINDS = ['finalize-trip', 'trip-actions'] as const;

export type SyncKind = (typeof SYNC_KINDS)[number];

export const isSyncKind = (value: string): value is SyncKind => (SYNC_KINDS as readonly string[]).includes(value);
