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
// with no samples was never a drive worth keeping and is removed.
import { mergeEvents, type TripDetectors } from '@/core/detectors';
import { ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import { createSamplesRepo, createTripsRepo, type Db, type TripRow } from '@/data/db';
import type { StartSource, TripRole } from './engine.types';
import { finalizeTrip, nightAt, type FinalizeDeps } from './finalize';
import { appendRow, closeSession, createSession } from './session';
import type { DetectorContext, DriveMode, FeatureRow, LimitSample } from './types';

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
}

export interface RecoveryResult {
  /** Finalized as `incomplete`, in the order they were driven. */
  recovered: string[];
  /** Removed: a `recording` row with no samples. */
  discarded: string[];
  /** Left exactly as found, to be retried at the next start. */
  failed: { clientTripId: string; error: unknown }[];
}

const MODES: readonly DriveMode[] = ['mounted', 'pocket', 'auto'];
const ROLES: readonly TripRole[] = ['driver', 'passenger'];
const SOURCES: readonly StartSource[] = ['manual', 'auto'];

/** A stored TEXT column back to its union, or `fallback` for anything the column should not hold. */
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.find((candidate) => candidate === value) ?? fallback;

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
  const samples = createSamplesRepo(db);
  const result: RecoveryResult = { recovered: [], discarded: [], failed: [] };

  async function recover(trip: TripRow): Promise<'recovered' | 'discarded'> {
    const id = trip.client_trip_id;
    const stored = await samples.range(id, 0, Number.MAX_SAFE_INTEGER);
    if (stored.length === 0) {
      await trips.remove(id);
      return 'discarded';
    }
    const rows = stored.map((s) => JSON.parse(s.row_json) as FeatureRow);

    const mode = oneOf(trip.mode, MODES, 'auto');
    const session = createSession({
      clientTripId: id,
      mode,
      role: oneOf(trip.role, ROLES, 'driver'),
      startSource: oneOf(trip.role_source, SOURCES, 'auto'),
      startedAt: trip.started_at,
    });
    if (trip.checkpoint_ts !== null) session.checkpoints.push(trip.checkpoint_ts);
    // The zone the trip was driven in, not the one the app relaunched in.
    const tz = trip.tz || deps.tz;
    // The host's per-row context is gone with the process; night is the trip's own condition,
    // the same clock rule the finalizer stores for it.
    const ctx: DetectorContext = {
      mode,
      night: nightAt(trip.started_at, tz, deps.scoring.CONSTANTS),
      precipitation: false,
    };
    const detectors = deps.createDetectors();
    for (const row of rows) {
      const limit = (await deps.limits?.lookup(row.lat, row.lng, row.course)) ?? UNKNOWN_LIMIT;
      appendRow(session, row, limit);
      session.events.push(...detectors.push(row, limit, ctx));
    }
    session.events = mergeEvents([...session.events, ...detectors.flush()]);

    // `rows` is non-empty, so the session has a last row; the trip ends one row-length after it.
    const closed = closeSession(session, (session.lastRowTs as number) + ROW_MS);
    await finalizeTrip(closed, {
      db,
      scoring: deps.scoring,
      tz,
      fs: deps.fs,
      hash: deps.hash,
      now: deps.now,
      cameraSession: deps.cameraSession,
      incomplete: true,
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
