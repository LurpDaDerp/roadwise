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
      const { changes } = await on.execute(
        `UPDATE sync_queue SET status = 'failed', last_error = ?, claimed_at = NULL
          WHERE id = ? AND status IN ('pending', 'failed')`,
        [error, id]
      );
      return changes === 0 ? null : get(id, on);
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
     */
    async reopen(
      idempotencyKey: string,
      now: number = Date.now(),
      on: Db = db
    ): Promise<QueueItem | null> {
      const { changes } = await on.execute(
        `UPDATE sync_queue
            SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
                claimed_at = NULL
          WHERE idempotency_key = ? AND status = 'failed'`,
        [now, idempotencyKey]
      );
      return changes === 0 ? null : byKey(idempotencyKey, on);
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
