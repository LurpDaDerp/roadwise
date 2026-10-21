// Rebuilding an interrupted drive from its durable rows, for `adopt` (a relaunch mid-drive, or a
// drive re-opened by a continuation) and for finalizing an orphan (the process died and the capture
// with it). The rows replay through the same session and detector steps as live, so the rebuilt
// drive (its miles, events and opportunity counters) is the one the live engine had.
import { createSamplesRepo, type Db, type TripRow } from '@/data/db';

import { ROW_MS, UNKNOWN_LIMIT } from '@/core/detectors/common';
import { MAX_DRIVE_MS } from '@/data/sync/payload';

import type { AdoptedTrip } from './engine.types';
import { appendRow, createSession, noteWarmup } from './session';
import type { DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

export interface RebuildDeps {
  createDetectors(): DetectorSuite;
  /** The phone that recorded the drive (this one): the detectors read it as they did live. */
  platform: DetectorContext['platform'];
  /** SQLite only, never the network: the stored tiles (sync or async). */
  limits: { lookup(lat: number, lng: number, course: number): LimitSample | null | Promise<LimitSample | null> };
}

/** The parked spot a drive started from, when its start came from the motion history (`start_source` `motion`). */
function startPlaceOf(trip: TripRow): { lat: number; lng: number } | null {
  if (trip.start_source !== 'motion' || trip.start_lat === null || trip.start_lng === null) return null;
  return { lat: trip.start_lat, lng: trip.start_lng };
}

/**
 * Replay the trip's samples through a fresh session and detector suite. Null when the trip has no
 * samples (nothing was recorded). A row that would carry the drive past `MAX_DRIVE_MS` is not
 * replayed (the live engine ends a drive before it), so a rebuilt drive's mark is always inside the bound.
 */
export async function rebuildFromSamples(db: Db, trip: TripRow, deps: RebuildDeps): Promise<AdoptedTrip | null> {
  const stored = await createSamplesRepo(db).range(trip.client_trip_id, 0, Number.MAX_SAFE_INTEGER);
  if (stored.length === 0) return null;
  const session = createSession({
    clientTripId: trip.client_trip_id,
    startedAt: trip.started_at,
    origin: trip.origin,
    continues: trip.continues === 1,
    startSource: trip.start_source,
    startPlace: startPlaceOf(trip),
    continuations: trip.continuations,
  });
  const detectors = deps.createDetectors();
  for (const sample of stored) {
    let row: FeatureRow;
    try {
      row = JSON.parse(sample.row_json) as FeatureRow;
    } catch {
      continue;
    }
    if (session.lastRowTs !== null && row.ts <= session.lastRowTs) continue;
    if (row.ts + ROW_MS > trip.started_at + MAX_DRIVE_MS) continue;
    const limit = (await deps.limits.lookup(row.lat, row.lng, row.course)) ?? UNKNOWN_LIMIT;
    noteWarmup(session, row);
    const ctx: DetectorContext = { warmupEndsAt: session.warmup.endsAt, platform: deps.platform };
    const closed = detectors.push(row, limit, ctx);
    session.events.push(...closed);
    appendRow(session, row, { unsafe: detectors.unsafe(), limitUsable: detectors.speedingNow() !== null, platform: deps.platform });
  }
  // Every replayed row is already durable.
  session.pending = [];
  session.checkpointTs = session.lastRowTs;
  if (trip.last_seq !== null && (session.lastSeq === null || trip.last_seq > session.lastSeq)) session.lastSeq = trip.last_seq;
  return { session, detectors };
}
