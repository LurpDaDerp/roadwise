// Rebuilding an interrupted drive from its durable rows, for `adopt` (a relaunch mid-drive) and
// for finalizing an orphan (the process died and the capture with it).
import { createSamplesRepo, type Db, type TripRow } from '@/data/db';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';

import type { AdoptedTrip } from './engine.types';
import { appendRow, createSession } from './session';
import type { DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

export interface RebuildDeps {
  createDetectors(): DetectorSuite;
  /** SQLite only, never the network: the stored tiles (sync or async). */
  limits: { lookup(lat: number, lng: number, course: number): LimitSample | null | Promise<LimitSample | null> };
}

/**
 * Replay the trip's samples through a fresh session and detector suite. Null when the trip has no
 * samples (nothing was recorded). The lock signal is not known after a relaunch, so unlock evidence
 * is not believed; handling still counts.
 */
export async function rebuildFromSamples(db: Db, trip: TripRow, deps: RebuildDeps): Promise<AdoptedTrip | null> {
  const stored = await createSamplesRepo(db).range(trip.client_trip_id, 0, Number.MAX_SAFE_INTEGER);
  if (stored.length === 0) return null;
  const session = createSession({ clientTripId: trip.client_trip_id, startedAt: trip.started_at, dmsOn: trip.dms_on === 1 });
  session.dmsFaceSeen = trip.dms_face_seen === 1;
  const detectors = deps.createDetectors();
  const ctx: DetectorContext = { tripStartedAt: trip.started_at, callActive: false, lockReliable: false, lockLagged: false };
  for (const sample of stored) {
    let row: FeatureRow;
    try {
      row = JSON.parse(sample.row_json) as FeatureRow;
    } catch {
      continue;
    }
    if (session.lastRowTs !== null && row.ts <= session.lastRowTs) continue;
    const limit = (await deps.limits.lookup(row.lat, row.lng, row.course)) ?? UNKNOWN_LIMIT;
    const closed = detectors.push(row, limit, ctx);
    session.events.push(...closed);
    appendRow(session, row, detectors.unsafe(), false);
  }
  // Every replayed row is already durable.
  session.pending = [];
  session.checkpointTs = session.lastRowTs;
  return { session, detectors };
}
