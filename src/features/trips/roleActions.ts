/**
 * "Were you driving?" (§7.C C10): the answer is written locally first and owed to the server.
 *
 * The local write is what the driver sees at once — a passenger or transit trip loses its score
 * on the spot, a driver's trip keeps whatever it had and waits for the server to score it. The
 * queue item carries the `trip-actions` request body verbatim (`{ action: 'set-role', … }`), so
 * the runner's handler for this kind (Task 7) can send it as it is, the way `finalize-trip`
 * payloads are sent. Until that handler lands the runner leaves the item queued, and nothing is
 * lost. Every change is its own item, in order, so the last answer is the one the server keeps.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import {
  createQueueRepo,
  createTripsRepo,
  MissingTripError,
  type Db,
  type TripPatch,
  type TripRow,
} from '@/data/db';
import { invalidateTrip, useDb } from '@/data/queries';
import type { SyncKind } from '@/data/sync/kinds';
import { currentOwnerUid, emitQueueChanged } from '@/data/sync/queue';

/** The three answers the chips offer; `trips.role` stores the same words. */
export type ChosenRole = 'driver' | 'passenger' | 'other';

export const SET_ROLE_KIND: SyncKind = 'set-role';

/** The `trip-actions` request for a role change, as Task 2b's function reads it. */
export interface SetRolePayload {
  action: 'set-role';
  clientTripId: string;
  role: ChosenRole;
}

/**
 * One item per answer: a driver who changes their mind queues a second, later item, and the
 * server keeps the last one.
 *
 * The stamp is **strictly increasing within the process**, not `Date.now()` — two answers inside
 * the same millisecond would otherwise build the same key and `INSERT OR IGNORE` would silently
 * drop the second, leaving the local row and the server disagreeing (Task 6 review, M-13). Across
 * a relaunch the wall clock has moved on, so the sequence keeps rising.
 */
let lastStamp = 0;

export function roleStamp(now: number): number {
  lastStamp = Math.max(now, lastStamp + 1);
  return lastStamp;
}

export const setRoleIdempotencyKey = (clientTripId: string, now: number): string =>
  `role:${clientTripId}:${now}`;

/**
 * Store the answer and queue it, in one transaction. A trip nobody drove has no score to keep;
 * a driver's trip keeps its row as it is — the server re-scores it and the runner writes the
 * score back — so the summary reads "calculating" rather than a reason that is not true.
 */
export async function setTripRole(
  db: Db,
  clientTripId: string,
  role: ChosenRole,
  now: number = Date.now()
): Promise<TripRow> {
  // Stamped like every other queued request: an item with no owner is sent by whatever session
  // happens to be live, which is the hole the column exists to close.
  const owner = await currentOwnerUid(db);
  const row = await db.transaction(async (tx) => {
    const trips = createTripsRepo(db);
    const current = await trips.get(clientTripId, tx);
    if (current === null) throw new MissingTripError(clientTripId);

    const patch: TripPatch = { role, role_source: 'manual' };
    if (role !== 'driver') {
      patch.status = 'unscored';
      patch.score = null;
    }
    const updated = await trips.update(clientTripId, patch, now, tx);
    if (updated === null) throw new MissingTripError(clientTripId);

    const payload: SetRolePayload = { action: 'set-role', clientTripId, role };
    await createQueueRepo(db).enqueue(
      SET_ROLE_KIND,
      payload,
      setRoleIdempotencyKey(clientTripId, roleStamp(now)),
      now,
      tx,
      owner
    );
    return updated;
  });
  // After the commit, so a listener that drains meets the row, not the lock.
  emitQueueChanged();
  return row;
}

export interface SetTripRole {
  setRole(clientTripId: string, role: ChosenRole): Promise<void>;
  /** The answer being written, so the chip pressed can show it and the others can wait. */
  busy: ChosenRole | null;
  failed: boolean;
}

/** The chips' hook: write, then refresh every query the trip appears in. */
export function useSetTripRole(): SetTripRole {
  const db = useDb();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ChosenRole | null>(null);
  const [failed, setFailed] = useState(false);

  const setRole = useCallback(
    async (clientTripId: string, role: ChosenRole) => {
      setBusy(role);
      setFailed(false);
      try {
        await setTripRole(db, clientTripId, role);
        await invalidateTrip(queryClient, clientTripId);
      } catch {
        setFailed(true);
      } finally {
        setBusy(null);
      }
    },
    [db, queryClient]
  );

  return { setRole, busy, failed };
}
