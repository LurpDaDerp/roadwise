// Rebuilding a recording trip from its durable rows (spec §19.1).
//
// A trip the previous process was recording is a `recording` row, its checkpointed samples and —
// since M3 — the arbiter state stored with the last checkpoint. Nothing else survived: the events,
// the alerts, the gaps and the detectors' open episodes lived in memory. This module turns what is
// on disk back into an open `TripSession` plus the detector suite the rows were replayed through,
// which is exactly what both consumers need:
//   - `recoverRecordingTrips` closes it and finalizes it as `incomplete`;
//   - the drive host hands it to the engine as `adopt`, and the same drive carries on.
// One rebuild for both, so an adopted trip and a recovered one can never be judged differently.
import type { ArbiterState } from '@/core/alerts/types';
import type { TripDetectors } from '@/core/detectors';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { createSamplesRepo, createSettingsRepo, type Db, type TripRow } from '@/data/db';
import type { TripRole, TripSession } from './engine.types';
import { nightAt } from './finalize';
import { arbiterStateKey } from './recorder';
import { appendRow, createSession, startFromRoleSource } from './session';
import type { DetectorContext, DriveMode, FeatureRow, LimitSample } from './types';

export interface ReplayDeps {
  /** A fresh detector suite, as `EngineDeps.createDetectors`. */
  createDetectors(): TripDetectors;
  /**
   * The local speed-limit tile cache, if the host has one — the same arguments as
   * `EngineDeps.limits.lookup`, heading included, sync or async. Never the network: a rebuild
   * runs at app start, connected or not, and a row nothing is cached for is judged against
   * `UNKNOWN_LIMIT` (no speeding without a limit; harsh and phone events are still detected).
   */
  limits?: {
    lookup(
      lat: number,
      lng: number,
      course: number
    ): LimitSample | null | Promise<LimitSample | null>;
  };
  /** The device zone now: only the fallback for a row stored without one. */
  tz: string;
  /** The night-rule hours, from the scoring package the host loaded. */
  constants: { NIGHT_START_H: number; NIGHT_END_H: number };
}

export interface RebuiltTrip {
  /** The open session: accumulators over every durable row, `checkpoints` = [checkpoint_ts]. */
  session: TripSession;
  /** The suite the rows went through, NOT flushed — open episodes are still open. */
  detectors: TripDetectors;
  /** How many durable rows were replayed. */
  rows: number;
  /** The arbiter state the recorder stored with the last checkpoint, or null. */
  arbiterState: ArbiterState | null;
}

const MODES: readonly DriveMode[] = ['mounted', 'pocket', 'auto'];
const ROLES: readonly TripRole[] = ['driver', 'passenger'];

/** A stored TEXT column back to its union, or `fallback` for anything the column should not hold. */
const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.find((candidate) => candidate === value) ?? fallback;

/**
 * Rebuild `trip` from its samples, or null when it has none (it was never a drive worth keeping).
 *
 * The session keeps the trip's own id, start, role and mode; the start evidence comes back from
 * `role_source` (`startFromRoleSource`: `manual` → `tap`, `moving_start` → `movingStart`, anything
 * else → `auto`). Every row is replayed through a fresh suite with the trip's night condition and
 * `lockReliable: false` — the lock signal of a process that is gone cannot be vouched for, so the
 * phone detector takes neither app-switch nor unlock evidence from the replay (§9.5, I11). The
 * gaps the drive had are gone with the process, so `durationS` is the wall span of the rows.
 */
export async function rebuildFromSamples(
  db: Db,
  trip: TripRow,
  deps: ReplayDeps
): Promise<RebuiltTrip | null> {
  const id = trip.client_trip_id;
  const stored = await createSamplesRepo(db).range(id, 0, Number.MAX_SAFE_INTEGER);
  if (stored.length === 0) return null;
  const rows = stored.map((s) => JSON.parse(s.row_json) as FeatureRow);

  const mode = oneOf(trip.mode, MODES, 'auto');
  const session = createSession({
    clientTripId: id,
    mode,
    role: oneOf(trip.role, ROLES, 'driver'),
    ...startFromRoleSource(trip.role_source),
    startedAt: trip.started_at,
  });
  if (trip.checkpoint_ts !== null) session.checkpoints.push(trip.checkpoint_ts);

  // The zone the trip was driven in, not the one the app relaunched in.
  const tz = trip.tz || deps.tz;
  const ctx: DetectorContext = {
    mode,
    night: nightAt(trip.started_at, tz, deps.constants),
    precipitation: false,
    lockReliable: false,
    lockLagged: false,
  };
  const detectors = deps.createDetectors();
  for (const row of rows) {
    const limit = (await deps.limits?.lookup(row.lat, row.lng, row.course)) ?? UNKNOWN_LIMIT;
    appendRow(session, row, limit);
    session.events.push(...detectors.push(row, limit, ctx));
  }

  const arbiterState = await createSettingsRepo(db).get<ArbiterState>(arbiterStateKey(id));
  session.arbiterState = arbiterState;
  return { session, detectors, rows: rows.length, arbiterState };
}
