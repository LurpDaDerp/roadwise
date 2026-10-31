/**
 * Every kind of work the outbox carries. `sync_queue.kind` is a plain TEXT column; the enum lives
 * here so the enqueue sites and the runner's dispatch read one list.
 *
 * - `finalize-trip` — a finished drive: `POST finalize-trip` with its v4 payload (plan §3).
 * - `trip-actions` — a dispute or "wasn't driving" (plan §4); one from the recap notification goes
 *   to the `mark_passenger_ride` RPC instead.
 * - `passenger-ride` — the in-drive "Not driving?": the trip id and its day, to the
 *   `record_passenger_ride` RPC (its drive is never uploaded).
 */
export const SYNC_KINDS = ['finalize-trip', 'trip-actions', 'passenger-ride'] as const;

export type SyncKind = (typeof SYNC_KINDS)[number];

export const isSyncKind = (value: string): value is SyncKind => (SYNC_KINDS as readonly string[]).includes(value);
