import type { Db } from '@/data/db/driver';
import { asEnum, asNumber, asText, asTextOrNull } from '@/data/db/row';
import { QUEUE_STATUSES, type QueueItem, type QueueStatus } from '@/data/db/types';

/**
 * The outbox. Work the app owes the server — a finalized trip, a role correction, a dispute —
 * is written here first and drained later, so a drive that ends in a tunnel still uploads.
 *
 * Retries back off from 30 s, doubling to a one-hour ceiling, and give up after 20 attempts.
 * The server dedupes on `idempotency_key`, so a retry that actually succeeded the first time is
 * harmless.
 */

const FIRST_DELAY_S = 30;
const MAX_DELAY_S = 3600;
export const MAX_ATTEMPTS = 20;

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

  return {
    get: (id: number) => get(id),

    /**
     * Idempotent: enqueueing a key already in the queue keeps the item that is there, whatever
     * state it has reached, rather than queueing the same work twice.
     */
    enqueue(
      kind: string,
      payload: unknown,
      idempotencyKey: string,
      now: number = Date.now()
    ): Promise<QueueItem> {
      return db.transaction(async (tx) => {
        await tx.execute(
          `INSERT OR IGNORE INTO sync_queue
             (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
          [kind, JSON.stringify(payload), idempotencyKey, now, now]
        );
        const item = await byKey(idempotencyKey, tx);
        if (!item) throw new Error(`queue item ${idempotencyKey} vanished after insert`);
        return item;
      });
    },

    /**
     * Claim up to `limit` items whose retry time has arrived, marking them `inflight` in the
     * same transaction so two drain passes cannot pick up the same work.
     */
    nextDue(now: number = Date.now(), limit = 10): Promise<QueueItem[]> {
      return db.transaction(async (tx) => {
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
          await tx.execute("UPDATE sync_queue SET status = 'inflight' WHERE id = ?", [item.id]);
          claimed.push({ ...item, status: 'inflight' });
        }
        return claimed;
      });
    },

    /**
     * Close out one attempt. Success marks the item `done` and clears the error; failure records
     * it and schedules the next try, or gives up at `MAX_ATTEMPTS`.
     */
    async markAttempt(
      id: number,
      ok: boolean,
      error: string | null = null,
      now: number = Date.now()
    ): Promise<QueueItem | null> {
      const current = await get(id);
      if (!current) return null;

      if (ok) {
        await db.execute(
          "UPDATE sync_queue SET status = 'done', last_error = NULL WHERE id = ?",
          [id]
        );
        return get(id);
      }

      const attempts = current.attempts + 1;
      const givingUp = attempts >= MAX_ATTEMPTS;
      await db.execute(
        'UPDATE sync_queue SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
        [
          givingUp ? 'failed' : 'pending',
          attempts,
          givingUp ? current.next_attempt_at : now + backoffSeconds(current.attempts) * 1000,
          error,
          id,
        ]
      );
      return get(id);
    },

    async countByStatus(status: QueueStatus): Promise<number> {
      const { rows } = await db.execute('SELECT count(*) AS n FROM sync_queue WHERE status = ?', [
        status,
      ]);
      return asNumber(rows[0] ?? {}, 'n');
    },

    /** Housekeeping: finished items older than the cutoff are of no further use. */
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
