// Crash recovery: a `recording` row left by a process that died. If the native capture is still
// running for it (a sticky restart, a relaunch mid-drive) the drive is continued — the user
// started it, nothing here starts anything. Otherwise it is finalized as it stood (an orphan),
// or removed when nothing was ever recorded.
import { createTripsRepo, type Db, type TripRow } from '@/data/db';

import { ROW_MS } from '@/core/detectors/common';

import type { AdoptedTrip, TripSession } from './engine.types';
import { rebuildFromSamples, type RebuildDeps } from './replay';
import { closeSession } from './session';

export interface RecoveryDeps extends RebuildDeps {
  /** Whether the drive may be continued: the capture still runs and its last row is recent. */
  adoptable(trip: TripRow, lastRowTs: number | null): Promise<boolean>;
  /** Store and queue a closed session (`finalizeTrip`). */
  finalize(session: Readonly<TripSession>): Promise<void>;
  now(): number;
}

export interface RecoveryResult {
  /** The one drive to continue, rebuilt; null when none. */
  adopt: AdoptedTrip | null;
  finalized: string[];
  removed: string[];
  failed: { clientTripId: string; error: unknown }[];
}

export async function recoverRecordingTrips(db: Db, deps: RecoveryDeps): Promise<RecoveryResult> {
  const trips = createTripsRepo(db);
  const result: RecoveryResult = { adopt: null, finalized: [], removed: [], failed: [] };
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
      const endedAt = (rebuilt.session.lastRowTs ?? trip.started_at) + ROW_MS;
      await deps.finalize(closeSession(rebuilt.session, endedAt, 'orphan'));
      result.finalized.push(trip.client_trip_id);
    } catch (error) {
      result.failed.push({ clientTripId: trip.client_trip_id, error });
    }
  }
  return result;
}
