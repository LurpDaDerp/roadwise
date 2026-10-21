import type { Db } from '@/data/db/driver';
import { asEnum, asNumber, asNumberOrNull, asText, asTextOrNull } from '@/data/db/row';
import { QUEUE_STATUSES, type QueueItem, type QueueStatus } from '@/data/db/types';

/**
 * The outbox. Work the app owes the server — a finished drive, a dispute, "wasn't driving" — is
 * written here first and drained later, so a drive that ends in a tunnel still uploads.
 *
 * Retries back off from 30 s, doubling to a one-hour ceiling, and give up after 20 attempts. The
 * server is idempotent on the item's key, so a retry that actually succeeded is harmless.
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

/** Seconds to wait before the next try: 30, 60, 120, 240, 480, 960, 1920, then one hour forever. */
export function backoffSeconds(attempts: number): number {
  return Math.min(MAX_DELAY_S, FIRST_DELAY_S * 2 ** Math.max(0, attempts));
}

/** `next_attempt_at` of an item the server refused for good: never. */
export const REFUSED_NEVER = Number.MAX_SAFE_INTEGER;

/** `last_error` of an attempt that never reached a server; such an item is reopened on every reconnect. */
export const TRANSPORT_FAILURE = 'network';
/**
 * `last_error` of an attempt that found no function at the URL. An earlier build took that for a
 * refusal and failed the item for good; it is reopened like any other, since a deploy answers it.
 */
export const FUNCTION_MISSING = 'http_404';
/** An item that ran out on server answers is reopened only this long after it gave up. */
export const SERVER_REOPEN_AFTER_MS = 24 * 60 * 60 * 1000;

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
    const { rows } = await on.execute('SELECT * FROM sync_queue WHERE idempotency_key = ?', [idempotencyKey]);
    const row = rows[0];
    return row ? toQueueItem(row) : null;
  }

  async function reclaimInflight(olderThanS: number, now: number, on: Db): Promise<number> {
    const { changes } = await on.execute(
      `UPDATE sync_queue SET status = 'pending', next_attempt_at = ?, claimed_at = NULL
        WHERE status = 'inflight' AND (claimed_at IS NULL OR claimed_at <= ?)`,
      [now, now - olderThanS * 1000]
    );
    return changes;
  }

  async function claim(tx: Db, where: string, params: unknown[], now: number, limit: number): Promise<QueueItem[]> {
    const { rows } = await tx.execute(
      `SELECT * FROM sync_queue WHERE ${where} ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
      [...params, limit]
    );
    const claimed: QueueItem[] = [];
    for (const row of rows) {
      const item = toQueueItem(row);
      await tx.execute("UPDATE sync_queue SET status = 'inflight', claimed_at = ? WHERE id = ?", [now, item.id]);
      claimed.push({ ...item, status: 'inflight', claimed_at: now });
    }
    return claimed;
  }

  return {
    get: (id: number) => get(id),

    /** The item under an idempotency key, whatever state it has reached, or null. */
    byKey: (idempotencyKey: string) => byKey(idempotencyKey, db),

    reclaimInflight: (olderThanS: number = RECLAIM_AFTER_S, now: number = Date.now()) => reclaimInflight(olderThanS, now, db),

    /**
     * Idempotent: enqueueing a key already in the queue keeps the item that is there. Given a
     * transaction handle `on`, the insert joins that transaction.
     */
    enqueue(kind: string, payload: unknown, idempotencyKey: string, now: number = Date.now(), on?: Db, ownerUid: string | null = null): Promise<QueueItem> {
      const run = async (tx: Db): Promise<QueueItem> => {
        await tx.execute(
          `INSERT OR IGNORE INTO sync_queue
             (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, owner_uid, created_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [kind, JSON.stringify(payload), idempotencyKey, now, ownerUid, now]
        );
        const item = await byKey(idempotencyKey, tx);
        if (!item) throw new Error(`queue item ${idempotencyKey} vanished after insert`);
        return item;
      };
      return on ? run(on) : db.transaction(run);
    },

    /** Claim up to `limit` due items, marking them `inflight` in the same transaction. */
    nextDue(now: number = Date.now(), limit = 10, reclaimAfterS: number = RECLAIM_AFTER_S): Promise<QueueItem[]> {
      return db.transaction(async (tx) => {
        await reclaimInflight(reclaimAfterS, now, tx);
        return claim(tx, "status = 'pending' AND next_attempt_at <= ?", [now], now, limit);
      });
    },

    /**
     * Close out one attempt. Success marks the item `done`; failure records the error and schedules
     * the next try, or gives up at `MAX_ATTEMPTS`. Guarded by `status = 'inflight'`: closing the
     * same claim twice is a no-op. Null when nothing changed.
     */
    markAttempt(id: number, ok: boolean, error: string | null = null, now: number = Date.now()): Promise<QueueItem | null> {
      return db.transaction(async (tx) => {
        const { rows } = await tx.execute("SELECT * FROM sync_queue WHERE id = ? AND status = 'inflight'", [id]);
        const row = rows[0];
        if (!row) return null;
        const current = toQueueItem(row);
        if (ok) {
          await tx.execute("UPDATE sync_queue SET status = 'done', last_error = NULL, claimed_at = NULL WHERE id = ? AND status = 'inflight'", [id]);
          return get(id, tx);
        }
        const attempts = current.attempts + 1;
        const givingUp = attempts >= MAX_ATTEMPTS;
        await tx.execute(
          `UPDATE sync_queue SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, claimed_at = NULL
            WHERE id = ? AND status = 'inflight'`,
          [givingUp ? 'failed' : 'pending', attempts, givingUp ? current.next_attempt_at : now + backoffSeconds(current.attempts) * 1000, error, id]
        );
        return get(id, tx);
      });
    },

    /** Give a claim back without counting an attempt (no session yet, a locked database). */
    async release(id: number, nextAttemptAt: number = Date.now(), on: Db = db): Promise<QueueItem | null> {
      const { changes } = await on.execute(
        "UPDATE sync_queue SET status = 'pending', claimed_at = NULL, next_attempt_at = ? WHERE id = ? AND status = 'inflight'",
        [nextAttemptAt, id]
      );
      return changes === 0 ? null : get(id, on);
    },

    /** Push an item's next try out to `at`, never in (the server's `Retry-After`). */
    async deferUntil(id: number, at: number, on: Db = db): Promise<QueueItem | null> {
      const { changes } = await on.execute('UPDATE sync_queue SET next_attempt_at = ? WHERE id = ? AND next_attempt_at < ?', [at, id, at]);
      return changes === 0 ? null : get(id, on);
    },

    /** Give up for good — the server refused it with an error retrying cannot fix. */
    async markFailed(id: number, error: string, on: Db = db): Promise<QueueItem | null> {
      const { changes } = await on.execute(
        `UPDATE sync_queue SET status = 'failed', last_error = ?, claimed_at = NULL, next_attempt_at = ?
          WHERE id = ? AND status IN ('pending', 'failed')`,
        [error, REFUSED_NEVER, id]
      );
      return changes === 0 ? null : get(id, on);
    },

    /**
     * Put back every item that gave up only because its retries ran out, with a clean ladder, due
     * now. An item the server refused stays failed, unless the "refusal" was a missing function
     * (`FUNCTION_MISSING`): that is reopened too. One that ran out on server answers is reopened
     * only `SERVER_REOPEN_AFTER_MS` after it gave up. Returns how many were reopened.
     */
    reopenRetryable(now: number = Date.now()): Promise<number> {
      return db.transaction(async (tx) => {
        const { rows } = await tx.execute(
          "SELECT * FROM sync_queue WHERE status = 'failed' AND ((attempts >= ? AND next_attempt_at <> ?) OR last_error = ?)",
          [MAX_ATTEMPTS, REFUSED_NEVER, FUNCTION_MISSING]
        );
        let reopened = 0;
        for (const item of rows.map(toQueueItem)) {
          const serverSide = item.last_error !== TRANSPORT_FAILURE && item.last_error !== FUNCTION_MISSING;
          if (serverSide && now - item.next_attempt_at < SERVER_REOPEN_AFTER_MS) continue;
          reopened += 1;
          await tx.execute(
            "UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, claimed_at = NULL WHERE id = ? AND status = 'failed'",
            [now, item.id]
          );
        }
        return reopened;
      });
    },

    /**
     * Items never tried yet (held back only for want of a session, another owner's turn or a busy
     * database) are due now: a sign-in sends them without waiting out the hold. Items in a retry
     * back-off keep their time. Returns how many moved.
     */
    async makeUntriedDue(now: number = Date.now()): Promise<number> {
      const { changes } = await db.execute(
        "UPDATE sync_queue SET next_attempt_at = ? WHERE status = 'pending' AND attempts = 0 AND next_attempt_at > ?",
        [now, now]
      );
      return changes;
    },

    /** The earliest `next_attempt_at` of an item still owed, or null when none is. */
    async nextPendingAt(): Promise<number | null> {
      const { rows } = await db.execute("SELECT MIN(next_attempt_at) AS at FROM sync_queue WHERE status = 'pending'");
      const at = rows[0]?.at;
      return typeof at === 'number' ? at : null;
    },

    async countByStatus(status: QueueStatus): Promise<number> {
      const { rows } = await db.execute('SELECT count(*) AS n FROM sync_queue WHERE status = ?', [status]);
      return asNumber(rows[0] ?? {}, 'n');
    },

    async dropByKey(idempotencyKey: string, on: Db = db): Promise<boolean> {
      const { changes } = await on.execute('DELETE FROM sync_queue WHERE idempotency_key = ?', [idempotencyKey]);
      return changes > 0;
    },

    /**
     * Drop the item under `idempotencyKey` only while it is still held and never tried (`pending`,
     * no attempt): the guard a re-opened drive takes, in the same transaction as the re-open, so an
     * upload already claimed or sent is never pulled back. True when it was dropped.
     */
    async dropUntried(idempotencyKey: string, on: Db = db): Promise<boolean> {
      const { changes } = await on.execute("DELETE FROM sync_queue WHERE idempotency_key = ? AND status = 'pending' AND attempts = 0", [idempotencyKey]);
      return changes > 0;
    },

    /** Every item of one kind the queue has given up on. */
    async listFailed(kind: string, on: Db = db): Promise<QueueItem[]> {
      const { rows } = await on.execute("SELECT * FROM sync_queue WHERE kind = ? AND status = 'failed' ORDER BY id ASC", [kind]);
      return rows.map(toQueueItem);
    },

    /** Housekeeping: finished items older than the cutoff are of no further use. */
    async purgeDone(createdBefore: number): Promise<number> {
      const { changes } = await db.execute("DELETE FROM sync_queue WHERE status = 'done' AND created_at < ?", [createdBefore]);
      return changes;
    },
  };
}

export type QueueRepo = ReturnType<typeof createQueueRepo>;
