// A drive that picks up where the last one ended (modes plan §3.5, R2): every end finalizes at once
// and holds its upload for `CONTINUE_HOLD_MS`; a drive confirmed while that hold stands, whose
// traced-back start is within `CONTINUE_DIST_M` of that end, re-opens the SAME trip instead of
// starting a new one. The two legs are one drive in history, one recap and one upload. A re-open
// needs the held upload never tried and the first leg's samples still there; otherwise the next
// drive is a new trip and the server's own merge (300 s / 150 m) joins them.
import { MERGE_RADIUS_M } from '@scoring';

import type { AdoptedTrip } from '@/core/engine/engine.types';
import { UPLOAD_HOLD_MS } from '@/core/engine/finalize';
import { rebuildFromSamples, type RebuildDeps } from '@/core/engine/replay';
import { createQueueRepo, createSamplesRepo, createTripsRepo, type Db } from '@/data/db';
import { finalizeIdempotencyKey } from '@/data/sync/queue';
import { haversineMeters } from '@/lib/geo';

/** The hold after every finalize (= `MERGE_GAP_S`): a re-open is possible this long after the end was decided. */
export const CONTINUE_HOLD_MS = UPLOAD_HOLD_MS;
/** The new start within this of the last end (m). */
export const CONTINUE_DIST_M = MERGE_RADIUS_M;

/** A held drive the next one continues. */
export interface Continuation {
  clientTripId: string;
  /** When its end was decided (`trips.finalized_at`). */
  finalizedAt: number;
  /** Where it ended (4 dp). */
  endFix: { lat: number; lng: number };
}

/** Candidates, newest first: kept drives finalized within the hold that still wait to upload. */
const CANDIDATES_SQL = `SELECT client_trip_id, finalized_at, end_lat, end_lng FROM trips
  WHERE status = 'pending' AND finalized_at IS NOT NULL AND finalized_at >= ?
    AND end_lat IS NOT NULL AND end_lng IS NOT NULL
  ORDER BY finalized_at DESC LIMIT 5`;

/**
 * The drive a start at `fix` continues, or null: the latest `pending` trip finalized within
 * `CONTINUE_HOLD_MS` of `now`, ended within `CONTINUE_DIST_M` of `fix`, whose upload is still held
 * (for the whole hold: one made due early never re-opens) and never tried, and whose samples are
 * still kept. A null fix, or anything unreadable, is null.
 */
export async function continuationFor(db: Db, now: number, fix: { lat: number; lng: number } | null): Promise<Continuation | null> {
  if (fix === null || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null;
  try {
    const { rows } = await db.execute(CANDIDATES_SQL, [now - CONTINUE_HOLD_MS]);
    const queue = createQueueRepo(db);
    const samples = createSamplesRepo(db);
    for (const r of rows) {
      const id = r.client_trip_id;
      const finalizedAt = r.finalized_at;
      const lat = r.end_lat;
      const lng = r.end_lng;
      if (typeof id !== 'string' || typeof finalizedAt !== 'number' || typeof lat !== 'number' || typeof lng !== 'number') continue;
      if (finalizedAt > now) continue;
      if (haversineMeters({ lat, lng }, fix) > CONTINUE_DIST_M) continue;
      const item = await queue.byKey(finalizeIdempotencyKey(id));
      if (item === null || item.status !== 'pending' || item.attempts !== 0) continue;
      // Its hold was lifted (a report or "Wasn't driving" on it, a sign-out's flush): it uploads, never re-opens.
      if (item.next_attempt_at < finalizedAt + CONTINUE_HOLD_MS) continue;
      if ((await samples.count(id)) === 0) continue;
      return { clientTripId: id, finalizedAt, endFix: { lat, lng } };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Re-open the trip: in one transaction its held upload is dropped (only while still never tried)
 * and the row goes back to `recording` (no end, one more continuation); then the session is rebuilt
 * from its samples for an engine `adopt`. The rebuilt drive's idle clock runs from `at` (the new
 * leg's start), so the stop between the legs never ends it again before the new rows arrive. Null
 * when the trip can no longer be re-opened (its upload was claimed, or it changed): start a new one.
 */
export async function reopenTrip(db: Db, c: Continuation, deps: RebuildDeps & { now: number; at: number }): Promise<AdoptedTrip | null> {
  const trips = createTripsRepo(db);
  const queue = createQueueRepo(db);
  const reopened = await db.transaction(async (tx) => {
    if (!(await queue.dropUntried(finalizeIdempotencyKey(c.clientTripId), tx))) return null;
    const row = await trips.reopen(c.clientTripId, deps.now, tx);
    // Not re-openable after all: roll the queue drop back with it.
    if (row === null) throw new ReopenRefused();
    return row;
  }).catch((e: unknown) => {
    if (e instanceof ReopenRefused) return null;
    throw e;
  });
  if (reopened === null) return null;
  const adopted = await rebuildFromSamples(db, reopened, deps);
  if (adopted === null) return null;
  const s = adopted.session;
  s.motion = Object.freeze({ ...s.motion, heldUntil: Math.max(s.motion.heldUntil ?? Number.NEGATIVE_INFINITY, deps.at) });
  return adopted;
}

class ReopenRefused extends Error {
  constructor() {
    super('trip could not be re-opened');
    this.name = 'ReopenRefused';
  }
}
