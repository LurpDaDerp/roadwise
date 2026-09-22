import type { Db } from '@/data/db/driver';
import { asEnum, asNumber, asNumberOrNull, asText, asTextOrNull } from '@/data/db/row';
import { QUEUE_STATUSES, type QueueItem, type QueueStatus } from '@/data/db/types';

/**
 * The outbox. Work the app owes the server — a finalized trip, a role correction, a dispute —
 * is written here first and drained later, so a drive that ends in a tunnel still uploads.
 *
 * Retries back off from 30 s, doubling to a one-hour ceiling, and give up after 20 attempts.
 * The server dedupes on `idempotency_key`, so a retry that actually succeeded the first time is
 * harmless.
 *
 * An item moves `pending → inflight` when `nextDue` claims it and back out when `markAttempt`
 * closes the attempt. A process killed mid-upload leaves the claim open, so `nextDue` first
 * reclaims claims older than `RECLAIM_AFTER_S`.
 */

const FIRST_DELAY_S = 30;
const MAX_DELAY_S = 3600;
export const MAX_ATTEMPTS = 20;

/** How long a claim may stand before `nextDue` assumes the uploader died holding it. */
export const RECLAIM_AFTER_S = 300;

/**
 * Seconds to wait before the next try, given how many attempts have already failed:
 * 30, 60, 120, 240, 480, 960, 1920, then one hour forever.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(MAX_DELAY_S, FIRST_DELAY_S * 2 ** Math.max(0, attempts));
}

/**
 * `next_attempt_at` of an item the server refused for good: never. A failed item's retry time is
 * otherwise meaningless, so this is the one mark that separates a refusal from an exhausted
 * ladder without a schema change.
 */
export const REFUSED_NEVER = Number.MAX_SAFE_INTEGER;

/**
 * The reason the sync runner records on a trip or a report whose item ran out of retries. Kept
 * equal to `RETRIES_EXHAUSTED` in `src/data/sync/actions.ts` (a test pins it); declared here so the
 * database layer does not import the sync layer.
 */
const RETRIES_EXHAUSTED = 'retries_exhausted';

/** Queue kinds whose body names a trip, and whose give-up marks that trip failed. */
const TRIP_KINDS = new Set(['finalize-trip', 'set-role', 'delete-trip']);

function parseBody(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the thing a queued item is about has gone from the device (security review D2 I-1): a
 * trip deleted, discarded or removed, or a report's event removed with its drive. Such an item is
 * never reopened — its body can hold the driver's own words about a drive they asked to destroy.
 * A `delete-trip` item is always live: its husk may be gone, and the server still has to hear it.
 * A body this build cannot read names nothing, so it is not "gone" (the runner fails it unsent).
 */
async function subjectGone(tx: Db, item: QueueItem): Promise<boolean> {
  if (item.kind === 'delete-trip') return false;
  const body = parseBody(item.payload_json);
  if (body === null) return false;
  if (item.kind === 'dispute') {
    if (typeof body.clientEventId !== 'string') return false;
    const { rows } = await tx.execute('SELECT 1 FROM trip_events WHERE id = ?', [body.clientEventId]);
    return rows.length === 0;
  }
  if (typeof body.clientTripId !== 'string') return false;
  const { rows } = await tx.execute(
    'SELECT status, deleted_at FROM trips WHERE client_trip_id = ?',
    [body.clientTripId]
  );
  const row = rows[0];
  return !row || row.status === 'discarded' || (row.deleted_at !== null && row.deleted_at !== undefined);
}

/** Take back what a reopened item's give-up recorded for the driver (see `reopenRetryable`). */
async function undoGiveUp(tx: Db, item: QueueItem, now: number): Promise<void> {
  const body = parseBody(item.payload_json);
  if (body === null) return;

  if (TRIP_KINDS.has(item.kind) && typeof body.clientTripId === 'string') {
    await tx.execute(
      `UPDATE trips SET sync_state = 'queued', sync_error = NULL, updated_at = ?
        WHERE client_trip_id = ? AND sync_state = 'failed' AND sync_error = ?`,
      [now, body.clientTripId, RETRIES_EXHAUSTED]
    );
    return;
  }

  if (item.kind === 'dispute' && typeof body.clientEventId === 'string') {
    const { rows } = await tx.execute('SELECT status, dispute_json FROM trip_events WHERE id = ?', [
      body.clientEventId,
    ]);
    const row = rows[0];
    const record = typeof row?.dispute_json === 'string' ? parseBody(row.dispute_json) : null;
    if (!row || record === null) return;
    if (record.outcome !== 'refused' || record.code !== RETRIES_EXHAUSTED) return;
    const sending = { ...record, outcome: 'queued', code: null, decidedAt: null };
    // Only a `scored` event is ever marked `disputed` while a report travels (a `possible` one
    // cost nothing and stays as it is), and the give-up put it back to `scored`.
    const status = row.status === 'scored' ? 'disputed' : row.status;
    await tx.execute('UPDATE trip_events SET status = ?, dispute_json = ? WHERE id = ?', [
      status,
      JSON.stringify(sending),
      body.clientEventId,
    ]);
  }
}

function toQueueItem(row: Record<string, unknown>): QueueItem {
  return {
    id: asNumber(row, 'id'),
    kind: asText(row, 'kind'),
    payload_json: asText(row, 'payload_json'),
    idempotency_key: asText(row, 'idempotency_key'),
    status: asEnum(row, 'status', QUEUE_STATUSES),
    attempts: asNumber(row, 'attempts'),
    next_attempt_at: asNumber(row, 'next_attempt_at'),
    claimed_at: asNumberOrNull(row, 'claimed_at'),
    trace_uploaded_at: asNumberOrNull(row, 'trace_uploaded_at'),
    owner_uid: asTextOrNull(row, 'owner_uid'),
    last_error: asTextOrNull(row, 'last_error'),
    created_at: asNumber(row, 'created_at'),
  };
}

export function createQueueRepo(db: Db) {
  async function get(id: number, on: Db = db): Promise<QueueItem | null> {
    const { rows } = await on.execute('SELECT * FROM sync_queue WHERE id = ?', [id]);
    const row = rows[0];
    return row ? toQueueItem(row) : null;
  }

  async function byKey(idempotencyKey: string, on: Db): Promise<QueueItem | null> {
    const { rows } = await on.execute('SELECT * FROM sync_queue WHERE idempotency_key = ?', [
      idempotencyKey,
    ]);
    const row = rows[0];
    return row ? toQueueItem(row) : null;
  }

  /**
   * Hand back claims nobody closed out. Attempts are left untouched — the upload may well have
   * reached the server, and the idempotency key is what stops a duplicate.
   */
  async function reclaimInflight(
    olderThanS: number = RECLAIM_AFTER_S,
    now: number = Date.now(),
    on: Db = db
  ): Promise<number> {
    const { changes } = await on.execute(
      `UPDATE sync_queue
          SET status = 'pending', next_attempt_at = ?, claimed_at = NULL
        WHERE status = 'inflight' AND (claimed_at IS NULL OR claimed_at <= ?)`,
      [now, now - olderThanS * 1000]
    );
    return changes;
  }

  return {
    get: (id: number) => get(id),

    /** The item under an idempotency key, whatever state it has reached, or null. */
    byKey: (idempotencyKey: string) => byKey(idempotencyKey, db),

    reclaimInflight: (olderThanS: number = RECLAIM_AFTER_S, now: number = Date.now()) =>
      reclaimInflight(olderThanS, now),

    /**
     * Idempotent: enqueueing a key already in the queue keeps the item that is there, whatever
     * state it has reached, rather than queueing the same work twice.
     *
     * Given a transaction handle `on`, the insert joins that transaction instead of opening its
     * own, so a caller can commit the queue item together with the rows it describes.
     */
    enqueue(
      kind: string,
      payload: unknown,
      idempotencyKey: string,
      now: number = Date.now(),
      on?: Db,
      ownerUid: string | null = null
    ): Promise<QueueItem> {
      const run = async (tx: Db): Promise<QueueItem> => {
        await tx.execute(
          `INSERT OR IGNORE INTO sync_queue
             (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, owner_uid,
              created_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [kind, JSON.stringify(payload), idempotencyKey, now, ownerUid, now]
        );
        const item = await byKey(idempotencyKey, tx);
        if (!item) throw new Error(`queue item ${idempotencyKey} vanished after insert`);
        return item;
      };
      return on ? run(on) : db.transaction(run);
    },

    /**
     * Claim up to `limit` items whose retry time has arrived, marking them `inflight` in the
     * same transaction so two drain passes cannot pick up the same work. Stale claims are
     * reclaimed first, inside that transaction, so a crashed upload is retried rather than lost.
     */
    nextDue(
      now: number = Date.now(),
      limit = 10,
      reclaimAfterS: number = RECLAIM_AFTER_S
    ): Promise<QueueItem[]> {
      return db.transaction(async (tx) => {
        await reclaimInflight(reclaimAfterS, now, tx);

        const { rows } = await tx.execute(
          `SELECT * FROM sync_queue
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT ?`,
          [now, limit]
        );
        const claimed: QueueItem[] = [];
        for (const row of rows) {
          const item = toQueueItem(row);
          await tx.execute(
            "UPDATE sync_queue SET status = 'inflight', claimed_at = ? WHERE id = ?",
            [now, item.id]
          );
          claimed.push({ ...item, status: 'inflight', claimed_at: now });
        }
        return claimed;
      });
    },

    /**
     * Claim every pending item of one `kind`, whatever its retry time — the last chance to send
     * it (sign-out flushes the deletes still owed while the outgoing session can still send
     * them). Same claim transaction and reclaim as `nextDue`.
     */
    nextDueOfKind(
      kind: string,
      now: number = Date.now(),
      limit = 10,
      reclaimAfterS: number = RECLAIM_AFTER_S
    ): Promise<QueueItem[]> {
      return db.transaction(async (tx) => {
        await reclaimInflight(reclaimAfterS, now, tx);
        const { rows } = await tx.execute(
          `SELECT * FROM sync_queue
            WHERE status = 'pending' AND kind = ?
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT ?`,
          [kind, limit]
        );
        const claimed: QueueItem[] = [];
        for (const row of rows) {
          const item = toQueueItem(row);
          await tx.execute(
            "UPDATE sync_queue SET status = 'inflight', claimed_at = ? WHERE id = ?",
            [now, item.id]
          );
          claimed.push({ ...item, status: 'inflight', claimed_at: now });
        }
        return claimed;
      });
    },

    /**
     * Close out one attempt. Success marks the item `done` and clears the error; failure records
     * it and schedules the next try, or gives up at `MAX_ATTEMPTS`.
     *
     * Guarded by `status = 'inflight'` and run in one transaction, so closing the same claim
     * twice — a retried callback, two drain passes racing — is a no-op rather than a double
     * increment. Returns the item as it now stands, or `null` when nothing changed (no such
     * item, or no claim open on it).
     */
    markAttempt(
      id: number,
      ok: boolean,
      error: string | null = null,
      now: number = Date.now()
    ): Promise<QueueItem | null> {
      return db.transaction(async (tx) => {
        const { rows } = await tx.execute(
          "SELECT * FROM sync_queue WHERE id = ? AND status = 'inflight'",
          [id]
        );
        const row = rows[0];
        if (!row) return null;
        const current = toQueueItem(row);

        if (ok) {
          await tx.execute(
            `UPDATE sync_queue SET status = 'done', last_error = NULL, claimed_at = NULL
              WHERE id = ? AND status = 'inflight'`,
            [id]
          );
          return get(id, tx);
        }

        const attempts = current.attempts + 1;
        const givingUp = attempts >= MAX_ATTEMPTS;
        await tx.execute(
          `UPDATE sync_queue
              SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, claimed_at = NULL
            WHERE id = ? AND status = 'inflight'`,
          [
            givingUp ? 'failed' : 'pending',
            attempts,
            givingUp ? current.next_attempt_at : now + backoffSeconds(current.attempts) * 1000,
            error,
            id,
          ]
        );
        return get(id, tx);
      });
    },

    /**
     * Give a claim back without counting an attempt, so the item is due again at
     * `nextAttemptAt`. For work that was not *tried* — no session yet, the trace is waiting for
     * Wi-Fi, the pass stopped on a locked database — where counting a failure would walk the
     * item towards `MAX_ATTEMPTS` for no fault of its own.
     *
     * Guarded by `status = 'inflight'`: null when the claim this caller held is already closed.
     */
    async release(
      id: number,
      nextAttemptAt: number = Date.now(),
      on: Db = db
    ): Promise<QueueItem | null> {
      const { changes } = await on.execute(
        `UPDATE sync_queue SET status = 'pending', claimed_at = NULL, next_attempt_at = ?
          WHERE id = ? AND status = 'inflight'`,
        [nextAttemptAt, id]
      );
      return changes === 0 ? null : get(id, on);
    },

    /**
     * Push an item's next try out to `at`, never in. The server's `Retry-After` outranks the
     * backoff ladder when it asks for longer; a shorter one is ignored, since the ladder exists
     * to protect a struggling server from the whole fleet at once.
     */
    async deferUntil(id: number, at: number, on: Db = db): Promise<QueueItem | null> {
      const { changes } = await on.execute(
        'UPDATE sync_queue SET next_attempt_at = ? WHERE id = ? AND next_attempt_at < ?',
        [at, id, at]
      );
      return changes === 0 ? null : get(id, on);
    },

    /**
     * Give up on an item for good — the server refused it with an error retrying cannot fix.
     * Called after `markAttempt(id, false, …)` has closed the claim, so the guard allows only
     * the states that attempt can have left behind: a fresh claim by another pass is not stomped.
     */
    async markFailed(id: number, error: string, on: Db = db): Promise<QueueItem | null> {
      // `next_attempt_at = REFUSED_NEVER` is what tells this refusal apart from a ladder that ran
      // out (`reopenRetryable`): a refusal on the twentieth attempt has the same count and status.
      const { changes } = await on.execute(
        `UPDATE sync_queue SET status = 'failed', last_error = ?, claimed_at = NULL,
                next_attempt_at = ?
          WHERE id = ? AND status IN ('pending', 'failed')`,
        [error, REFUSED_NEVER, id]
      );
      return changes === 0 ? null : get(id, on);
    },

    /**
     * Put back every item that gave up only because its retries ran out — the device was offline,
     * or the server kept answering 5xx or 429 — for when the network comes back (plan D2). Each
     * gets a clean ladder, due at `now`. An item the server **refused** (a 4xx other than 401,
     * 408, 409, 425, 429 — `markFailed`) stays failed: retrying would send the same bytes to the
     * same answer.
     *
     * What the give-up left for the driver to read is taken back in the same transaction, so a
     * screen does not keep saying "this will never upload" about work that is on its way again:
     * the trip of a reopened upload, role answer or delete goes back to `queued` — only while
     * `retries_exhausted` is still its recorded reason, so a trip refused for another reason keeps
     * it — and a reopened report goes back to "sending" on its event.
     *
     * An item whose trip or event has gone from the device is left failed (security review D2
     * I-1; see `subjectGone`).
     *
     * Returns how many items were reopened.
     */
    reopenRetryable(now: number = Date.now()): Promise<number> {
      return db.transaction(async (tx) => {
        const { rows } = await tx.execute(
          `SELECT * FROM sync_queue
            WHERE status = 'failed' AND attempts >= ? AND next_attempt_at <> ?`,
          [MAX_ATTEMPTS, REFUSED_NEVER]
        );
        let reopened = 0;
        for (const item of rows.map(toQueueItem)) {
          if (await subjectGone(tx, item)) continue;
          reopened += 1;
          await tx.execute(
            `UPDATE sync_queue
                SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
                    claimed_at = NULL
              WHERE id = ? AND status = 'failed'`,
            [now, item.id]
          );
          await undoGiveUp(tx, item, now);
        }
        return reopened;
      });
    },

    /**
     * Record that this item's large object is in Storage. Written the moment the upload returns,
     * outside any claim guard: the object is there whoever holds the claim now, and the point of
     * the mark is that the next attempt — this process or the next one — skips the upload.
     */
    async markTraceUploaded(
      id: number,
      at: number = Date.now(),
      on: Db = db
    ): Promise<QueueItem | null> {
      await on.execute(
        'UPDATE sync_queue SET trace_uploaded_at = ? WHERE id = ? AND trace_uploaded_at IS NULL',
        [at, id]
      );
      return get(id, on);
    },

    async countByStatus(status: QueueStatus): Promise<number> {
      const { rows } = await db.execute('SELECT count(*) AS n FROM sync_queue WHERE status = ?', [
        status,
      ]);
      return asNumber(rows[0] ?? {}, 'n');
    },

    /** Housekeeping: finished items older than the cutoff are of no further use. */
    /**
     * Remove one item outright, whatever state it is in. Used when the work itself has become
     * pointless -- a trace waiting for Wi-Fi on a drive the driver has just deleted. An item
     * another pass is holding `inflight` is dropped too; that pass's `markAttempt` then answers
     * null and it abandons the claim untouched, which is the behaviour it already has.
     */
    async dropByKey(idempotencyKey: string, on: Db = db): Promise<boolean> {
      const { changes } = await on.execute('DELETE FROM sync_queue WHERE idempotency_key = ?', [
        idempotencyKey,
      ]);
      return changes > 0;
    },

    /**
     * Put a `failed` item back in the queue with a clean ladder, for a driver who asked to try
     * again. Anything but `failed` is left alone: re-opening work that is pending or in flight
     * would reset a backoff that is doing its job.
     *
     * `payload` replaces the stored body. A second answer to the same question — a report re-sent
     * with a different reason — must travel as the answer the driver just gave, not as the one
     * the first attempt carried; the idempotency key is the same work, not the same words.
     */
    async reopen(
      idempotencyKey: string,
      now: number = Date.now(),
      on: Db = db,
      payload?: unknown
    ): Promise<QueueItem | null> {
      const sql =
        payload === undefined
          ? `UPDATE sync_queue
                SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
                    claimed_at = NULL
              WHERE idempotency_key = ? AND status = 'failed'`
          : `UPDATE sync_queue
                SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
                    claimed_at = NULL, payload_json = ?
              WHERE idempotency_key = ? AND status = 'failed'`;
      const params =
        payload === undefined
          ? [now, idempotencyKey]
          : [now, JSON.stringify(payload), idempotencyKey];
      const { changes } = await on.execute(sql, params);
      return changes === 0 ? null : byKey(idempotencyKey, on);
    },

    /**
     * Every item of one kind the queue has given up on. This is what "the server was never told"
     * actually means — a `failed` item — rather than any trip row that happens to carry a
     * `sync_error`, which an unrelated upload refusal also sets.
     */
    async listFailed(kind: string, on: Db = db): Promise<QueueItem[]> {
      const { rows } = await on.execute(
        "SELECT * FROM sync_queue WHERE kind = ? AND status = 'failed' ORDER BY id ASC",
        [kind]
      );
      return rows.map(toQueueItem);
    },

    async purgeDone(createdBefore: number): Promise<number> {
      const { changes } = await db.execute(
        "DELETE FROM sync_queue WHERE status = 'done' AND created_at < ?",
        [createdBefore]
      );
      return changes;
    },
  };
}

export type QueueRepo = ReturnType<typeof createQueueRepo>;
