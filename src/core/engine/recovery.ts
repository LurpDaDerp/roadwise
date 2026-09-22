// Crash recovery (spec §19.1: "phone dies mid-trip → trip finalized from last checkpoint; marked
// incomplete"; design §3.x "finalize from the last checkpoint").
//
// A trip the recorder was writing when the process died is a `recording` row plus its samples
// up to the last checkpoint. Nothing in memory survived — the detectors, the events, the alerts,
// the gaps — so the trip is rebuilt from the durable rows alone: replayed through a fresh detector
// suite with whatever limit the local tile cache still holds (no arbiter: nobody is driving and
// nothing is said), closed one row-length after its last row, and finalized exactly as the engine
// finalizes, flagged `incomplete`. With the gaps gone, `durationS` is the wall span from the
// first row to that close — a gap-merge pause the drive had is not subtracted. A `recording` row
// with no samples was never a drive worth keeping and is removed. The rebuild itself is
// `rebuildFromSamples` (replay.ts), shared with `adopt`, so a trip continued after a relaunch and
// a trip recovered as incomplete are judged by the same replay. The arbiter state the recorder
// kept for the trip goes with it: inside the finalize transaction, or with the removed row.
import { mergeEvents, type TripDetectors } from '@/core/detectors';
import { ROW_MS } from '@/core/detectors/common';
import { createSettingsRepo, createTripsRepo, type Db, type TripRow } from '@/data/db';
import { finalizeTrip, type FinalizeDeps } from './finalize';
import { arbiterStateKey } from './recorder';
import { rebuildFromSamples } from './replay';
import { roleEvidenceFor } from './rolePrior';
import { closeSession } from './session';
import type { LimitSample } from './types';

export interface RecoveryDeps
  extends Pick<FinalizeDeps, 'scoring' | 'tz' | 'fs' | 'hash' | 'cameraSession'> {
  /** A fresh detector suite per trip, as `EngineDeps.createDetectors`. */
  createDetectors(): TripDetectors;
  /**
   * The local speed-limit tile cache, if the host has one — the same arguments as
   * `EngineDeps.limits.lookup`, heading included, so a matcher that disambiguates by course
   * judges the replay exactly as it judged the drive; the engine's own in-memory lookup can be
   * handed over as is, or an async cache read. Never the network: recovery runs at app start,
   * connected or not, and a row nothing is cached for is judged against `UNKNOWN_LIMIT` — no
   * speeding without a limit; harsh and phone events are still detected.
   */
  limits?: {
    lookup(
      lat: number,
      lng: number,
      course: number
    ): LimitSample | null | Promise<LimitSample | null>;
  };
  /**
   * The device zone now. Only the fallback for a row stored without one: the trip is judged
   * (night rule) and reported in the zone it was driven in, `trips.tz`, which the recorder took
   * from the device at the first checkpoint.
   */
  tz: string;
  /** Wall clock for the row stamps. */
  now: () => number;
  /**
   * Leave this trip alone this time: it stays `recording` with its samples and is reported in
   * `skipped`. The host skips a trip it may adopt (checkpointed within the gap window while the
   * drive looks to be going on) and runs recovery again without `skip` for any it did not adopt.
   * A throw counts as that trip's failure.
   */
  skip?(trip: TripRow): boolean | Promise<boolean>;
}

export interface RecoveryResult {
  /** Finalized as `incomplete`, in the order they were driven. */
  recovered: string[];
  /** Removed: a `recording` row with no samples. */
  discarded: string[];
  /** Left exactly as found, to be retried at the next start. */
  failed: { clientTripId: string; error: unknown }[];
  /** Left `recording` because `skip` said so, oldest first — candidates for `adopt`. */
  skipped: string[];
}

/**
 * Finalize every trip left `recording` by a process that died, as `incomplete`.
 *
 * **Call at app start, before `createEngine`**: a live engine owns its `recording` row and its
 * checkpoints, and this function would finalize that trip out from under it. One trip's failure
 * is recorded in `failed` and does not stop the others; the trip stays `recording` with its
 * samples, so the next start tries again.
 */
export async function recoverRecordingTrips(db: Db, deps: RecoveryDeps): Promise<RecoveryResult> {
  const trips = createTripsRepo(db);
  const result: RecoveryResult = { recovered: [], discarded: [], failed: [], skipped: [] };

  async function recover(trip: TripRow): Promise<'recovered' | 'discarded' | 'skipped'> {
    const id = trip.client_trip_id;
    if (deps.skip && (await deps.skip(trip))) return 'skipped';
    const rebuilt = await rebuildFromSamples(db, trip, {
      createDetectors: deps.createDetectors,
      limits: deps.limits,
      tz: deps.tz,
      constants: deps.scoring.CONSTANTS,
    });
    if (rebuilt === null) {
      await db.transaction(async (tx) => {
        await trips.remove(id, tx);
        await createSettingsRepo(tx).remove(arbiterStateKey(id));
      });
      return 'discarded';
    }
    const { session, detectors } = rebuilt;
    session.events = mergeEvents([...session.events, ...detectors.flush()]);

    // The rebuild has at least one row, so the session has a last row; the trip ends one
    // row-length after it. The finalize transaction also removes the stored arbiter state.
    const closed = closeSession(session, (session.lastRowTs as number) + ROW_MS);
    // The same role evidence the host's finalize reads (final review I1): a recovered auto drive
    // is decided like one that ended normally, not asked about because the process died.
    const { rolePrior, habitualRoute } = await roleEvidenceFor(db, closed);
    await finalizeTrip(closed, {
      db,
      scoring: deps.scoring,
      tz: trip.tz || deps.tz,
      fs: deps.fs,
      hash: deps.hash,
      now: deps.now,
      cameraSession: deps.cameraSession,
      incomplete: true,
      rolePrior,
      habitualRoute,
    });
    return 'recovered';
  }

  // Newest first is the history order; the drives are finalized in the order they happened.
  const orphans = (await trips.list({ status: 'recording' })).reverse();
  for (const trip of orphans) {
    try {
      result[await recover(trip)].push(trip.client_trip_id);
    } catch (error) {
      result.failed.push({ clientTripId: trip.client_trip_id, error });
    }
  }
  return result;
}
