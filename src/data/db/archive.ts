/**
 * The 183-day rule (the server's twin is `private.route_retention()` in migration 0030): a drive
 * that ended more than `RETENTION_DAYS` ago keeps every number the stats read (miles, time, counts,
 * the clean flag, the counters) but loses where it went. Archiving one, in one transaction:
 * - a scored drive's route goes into `route_pool` (a line with no drive and no date), so the All
 *   trips map still draws it; any other drive's route is dropped (no map draws it);
 * - the route, the start and end points, the from/to labels and every event's place are cleared;
 * - any samples left go, and so does a finalize upload the server refused for good (its payload
 *   holds the route and the places);
 * - `archived_at` is stamped: the drive leaves every list and its recap reads as not found.
 *
 * Only a settled drive is archived (`ARCHIVABLE_STATUSES`): the server has answered it, or refused
 * it for good, or it could never be sent. And only while nothing is owed to the server for it
 * (`OWED_FOR_TRIP`): a "Wasn't driving" drive whose upload is still queued, or a drive whose upload
 * the queue will send again, waits. A drive still recording or still owed to the server is left
 * alone, however old, until it settles. Archiving is idempotent: an archived drive is never touched
 * again.
 */
import type { Db } from '@/data/db/driver';
import { FUNCTION_MISSING, REFUSED_NEVER } from '@/data/db/queue';
import { asNumber } from '@/data/db/row';
import type { TripStatus } from '@/data/db/types';

/** How long a drive keeps its route and places, in days. */
export const RETENTION_DAYS = 183;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** A drive that ended before this (epoch ms) is due to be archived at `now`. */
export const archiveCutoff = (now: number): number => now - RETENTION_MS;

/**
 * A drive lasts at most 12 hours (`MAX_DRIVE_MS`): a `recording` row started longer ago than this is
 * stale (crash recovery's to settle) and does not hold archiving back.
 */
export const RECORDING_MAX_MS = 12 * 60 * 60 * 1000;

/** Settled: the server answered (`scored`, `unscored`, `not_driving`) or never will (`failed`). */
export const ARCHIVABLE_STATUSES: readonly TripStatus[] = ['scored', 'unscored', 'not_driving', 'failed'];

const SETTLED = ARCHIVABLE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * A queue item still owed for the trip row in scope: the queue's own rule (`OWED` in queue.ts:
 * waiting, in flight, or failed without being refused for good), plus a refusal on a missing
 * function (`FUNCTION_MISSING`), which the queue's `reopenRetryable` sends again. Any kind counts
 * (the upload, a report, "Wasn't driving"): each one's payload names the drive's `clientTripId`.
 * The constants are the queue's own, written into the SQL (they are numbers and a fixed code).
 */
const OWED_FOR_TRIP = `EXISTS (SELECT 1 FROM sync_queue q WHERE json_valid(q.payload_json)
    AND json_extract(q.payload_json, '$.clientTripId') = trips.client_trip_id
    AND (q.status IN ('pending', 'inflight')
      OR (q.status = 'failed' AND (q.next_attempt_at <> ${REFUSED_NEVER} OR q.last_error = '${FUNCTION_MISSING}'))))`;

/** The drives due at a cutoff (one bound parameter): settled, ended before it, and owing nothing. */
const DUE = `archived_at IS NULL AND ended_at IS NOT NULL AND ended_at < ? AND status IN (${SETTLED}) AND NOT ${OWED_FOR_TRIP}`;

/** How many drives are due at `now`. */
export async function countDue(on: Db, now: number): Promise<number> {
  const { rows } = await on.execute(`SELECT COUNT(*) AS n FROM trips WHERE ${DUE}`, [archiveCutoff(now)]);
  return asNumber(rows[0] ?? {}, 'n');
}

/**
 * Archive every drive due at `now`, on `on` (call it inside a transaction: the statements belong
 * together). Set-based, so the number of statements does not grow with the drives. Returns how
 * many drives were archived.
 */
export async function archiveDue(on: Db, now: number): Promise<number> {
  const cutoff = archiveCutoff(now);
  const due = `SELECT client_trip_id FROM trips WHERE ${DUE}`;
  await on.execute(
    `INSERT OR IGNORE INTO route_pool (polyline)
       SELECT polyline FROM trips WHERE ${DUE} AND status = 'scored' AND polyline IS NOT NULL AND polyline != ''
       ORDER BY random()`,
    [cutoff]
  );
  await on.execute(`UPDATE trip_events SET lat = NULL, lng = NULL WHERE client_trip_id IN (${due}) AND (lat IS NOT NULL OR lng IS NOT NULL)`, [cutoff]);
  await on.execute(`DELETE FROM samples WHERE client_trip_id IN (${due})`, [cutoff]);
  // A refusal on a missing function is sent again (`reopenRetryable`), so it is never deleted here
  // (and its drive is not due while it is there).
  await on.execute(
    `DELETE FROM sync_queue WHERE kind = 'finalize-trip' AND status = 'failed' AND next_attempt_at = ?
       AND (last_error IS NULL OR last_error <> ?)
       AND json_valid(payload_json) AND json_extract(payload_json, '$.clientTripId') IN (${due})`,
    [REFUSED_NEVER, FUNCTION_MISSING, cutoff]
  );
  const { changes } = await on.execute(
    `UPDATE trips SET polyline = NULL, start_lat = NULL, start_lng = NULL, end_lat = NULL, end_lng = NULL,
       from_label = NULL, to_label = NULL, archived_at = ?, updated_at = ?
     WHERE ${DUE}`,
    [now, now, cutoff]
  );
  return changes;
}

/**
 * Whether a drive is under way at `now` (`recording`, started within `RECORDING_MAX_MS`): the
 * archive job leaves the database to it.
 */
export async function isRecording(on: Db, now: number): Promise<boolean> {
  const { rows } = await on.execute("SELECT EXISTS (SELECT 1 FROM trips WHERE status = 'recording' AND started_at > ?) AS r", [now - RECORDING_MAX_MS]);
  return asNumber(rows[0] ?? {}, 'r') !== 0;
}

/** The pooled routes: lines with nothing else, drawn beside the routes the drives still hold. */
export function createRoutePoolRepo(db: Db) {
  return {
    /** Every pooled line, in the table's own order: the lines' own (it has no rowid). */
    async list(on: Db = db): Promise<string[]> {
      const { rows } = await on.execute('SELECT polyline FROM route_pool');
      return rows.flatMap((row) => (typeof row.polyline === 'string' && row.polyline !== '' ? [row.polyline] : []));
    },

    /** Add lines; one the pool already holds, or an empty one, adds nothing. Returns how many were added. */
    async insertMany(lines: readonly string[], on: Db = db): Promise<number> {
      let added = 0;
      for (const line of lines) {
        if (line === '') continue;
        const { changes } = await on.execute('INSERT OR IGNORE INTO route_pool (polyline) VALUES (?)', [line]);
        added += changes;
      }
      return added;
    },

    async count(on: Db = db): Promise<number> {
      const { rows } = await on.execute('SELECT COUNT(*) AS n FROM route_pool');
      return asNumber(rows[0] ?? {}, 'n');
    },
  };
}

export type RoutePoolRepo = ReturnType<typeof createRoutePoolRepo>;
