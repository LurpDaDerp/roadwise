// Crash recovery: a `recording` row left by a process that died. If the native capture is still
// running for it (a sticky restart, a relaunch mid-drive) the drive is continued — the user
// started it, nothing here starts anything. Otherwise it is finalized as an orphan, closed where the
// car last moved (`closeAtLastMovement`) — or dropped when the car never moved — or removed when
// nothing was ever recorded.
import { createTripsRepo, type Db, type TripRow } from '@/data/db';

import type { AdoptedTrip, TripSession } from './engine.types';
import { rebuildFromSamples, type RebuildDeps } from './replay';
import { closeAtLastMovement } from './session';

export interface RecoveryDeps extends RebuildDeps {
  /** Whether the drive may be continued: the capture still runs and its last row is recent. */
  adoptable(trip: TripRow, lastRowTs: number | null): Promise<boolean>;
  /** Store and queue a closed session, or drop it when it never moved (`closeDrive`). */
  finalize(session: Readonly<TripSession>): Promise<'finalized' | 'dropped'>;
  now(): number;
}

export interface RecoveryResult {
  /** The one drive to continue, rebuilt; null when none. */
  adopt: AdoptedTrip | null;
  finalized: string[];
  /** Orphans that never moved: not kept (the caller tells Home why). */
  dropped: string[];
  removed: string[];
  failed: { clientTripId: string; error: unknown }[];
}

export async function recoverRecordingTrips(db: Db, deps: RecoveryDeps): Promise<RecoveryResult> {
  const trips = createTripsRepo(db);
  const result: RecoveryResult = { adopt: null, finalized: [], dropped: [], removed: [], failed: [] };
  const open = await trips.listRecording();
  // Only the newest can still be the drive under way; everything older is an orphan.
  for (const [i, trip] of open.entries()) {
    const newest = i === open.length - 1;
    try {
      const rebuilt = await rebuildFromSamples(db, trip, deps);
      if (rebuilt === null) {
        // Nothing was recorded: no drive to keep. (A drive ended by its driver always has a row
        // or two; one with none died before its first checkpoint.)
        await trips.remove(trip.client_trip_id);
        result.removed.push(trip.client_trip_id);
        continue;
      }
      if (newest && (await deps.adoptable(trip, rebuilt.session.lastRowTs))) {
        result.adopt = rebuilt;
        continue;
      }
      rebuilt.session.events.push(...rebuilt.detectors.flush());
      const outcome = await deps.finalize(closeAtLastMovement(rebuilt.session, 'orphan'));
      result[outcome].push(trip.client_trip_id);
    } catch (error) {
      result.failed.push({ clientTripId: trip.client_trip_id, error });
    }
  }
  return result;
}
