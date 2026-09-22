// The checkpoint recorder (design §2.3 "checkpoints durable in SQLite"; spec §19.1).
//
// The engine hands `onCheckpoint` the session every `CHECKPOINT_S` rows, as the trip goes to
// `ending`, and once more before `onFinalize`. This module is that callback: the first time it
// sees a trip it writes the `recording` row, then it appends the rows the row's own mark does not
// yet vouch for and advances the mark — all in one transaction, so a crash leaves either the whole
// checkpoint or none of it, and the mark never runs ahead of the rows it was offered. What it
// cannot promise is that no row is ever lost: the session's ring holds `RING_S` seconds, so rows a
// failed checkpoint left unwritten and a later one no longer finds in the ring are gone, and the
// mark then steps over the hole. The finalizer's metrics describe the durable rows in that case
// (its "when checkpoints were lost" test), and what this module leaves behind is exactly what
// `recovery.ts` finalizes from after a process death.
import { createSamplesRepo, createSettingsRepo, createTripsRepo, type Db } from '@/data/db';
import type { EngineDeps, TripSession } from './engine.types';
import { roleSourceFor } from './session';

/**
 * The settings key holding a recording trip's `ArbiterState` (the spent L1 budget, the drive
 * mute). Written with every checkpoint, removed inside the finalize transaction — by the engine's
 * finalize and recovery's alike — and read back by `rebuildFromSamples` for `adopt`.
 */
export const arbiterStateKey = (clientTripId: string): string => `engine.arbiter.${clientTripId}`;

export interface RecorderOptions {
  /** IANA zone of the device, stored on the trip row when it is created. */
  tz: string;
  /** Wall clock for the row stamps (`created_at`, `updated_at`). */
  now: () => number;
}

export interface Recorder {
  /**
   * `EngineDeps.onCheckpoint`. Idempotent: the same session delivered twice writes nothing twice,
   * because the floor is the durable `checkpoint_ts`, not the session's memory of it, and the
   * samples insert replaces on `(client_trip_id, ts)`. Never throws synchronously; a failure is
   * the returned rejection, which the engine reports (and leaves the checkpoint unrecorded, so
   * the rows are offered again at the next cadence).
   */
  onCheckpoint: EngineDeps['onCheckpoint'];
}

export function createRecorder(db: Db, opts: RecorderOptions): Recorder {
  const trips = createTripsRepo(db);
  const samples = createSamplesRepo(db);

  async function onCheckpoint(session: Readonly<TripSession>): Promise<void> {
    const id = session.clientTripId;
    await db.transaction(async (tx) => {
      const stamp = opts.now();
      const trip =
        (await trips.get(id, tx)) ??
        (await trips.insert(
          {
            client_trip_id: id,
            // The contract carries whole milliseconds; the OS backfill may not.
            started_at: Math.round(session.startedAt),
            tz: opts.tz,
            status: 'recording',
            sync_state: 'local',
            role: session.role,
            mode: session.mode,
            // `manual` / `moving_start` / `auto`: rebuilt by `startFromRoleSource` after a relaunch.
            role_source: roleSourceFor(session.startEvidence),
          },
          stamp,
          tx
        ));

      // The rows beyond the durable mark. The session's `checkpoints` would do the same job on a
      // happy path, but the mark is what survives a crash and what a checkpoint that committed
      // without the engine seeing it resolve has already moved — so it is the one to trust.
      const since = trip.checkpoint_ts ?? Number.NEGATIVE_INFINITY;
      const fresh = session.rows.filter((row) => row.ts > since);
      if (fresh.length > 0) {
        await samples.appendMany(
          id,
          fresh.map((row) => ({ ts: row.ts, row })),
          tx
        );
      }

      const last = session.lastRowTs;
      if (last !== null && last > since) await trips.checkpoint(id, Math.round(last), stamp, tx);

      // The role and mode can change mid-trip (a passenger tap, a manual restart inside the gap
      // window); recovery reads them from the row, so the row follows the session.
      if (trip.role !== session.role || trip.mode !== session.mode) {
        await trips.update(id, { role: session.role, mode: session.mode }, stamp, tx);
      }

      // The arbiter's resumable state, in the same commit as the rows it goes with.
      if (session.arbiterState !== null) {
        await createSettingsRepo(tx).set(arbiterStateKey(id), session.arbiterState);
      }
    });
  }

  return { onCheckpoint };
}
