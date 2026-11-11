/**
 * The reads for problem spots: the Analytics card and sheet (`useSpots`), the driving screen's
 * watcher (`readWatchSpots`) and the recompute job's inputs (`readSpotInputs`).
 *
 * Spots are the driver's own and never leave the phone, so they read each drive as the driver's
 * own views draw it: the whole route and the exact event places where the phone holds them. The
 * trimmed ends and the privacy zones, which shape only what leaves the phone, hide no spot.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { SpotEvent, SpotKind, WatchSpot } from '@/core/spots/types';
import type { Db } from '@/data/db/driver';
import { asNumber, asText } from '@/data/db/row';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo, parseSpotsMeta, SPOTS_META_KEY } from '@/data/db/spots';
import type { ProblemSpotRow } from '@/data/db/types';
import { readScoredDrives, SCORED_TRIP } from '@/data/queries/analytics';
import { useDataSource } from '@/data/queries/context';
import { queryKeys } from '@/data/queries/keys';
import type { LatLng } from '@/lib/geo';
import { decodePolyline } from '@/lib/polyline';

const DAY_MS = 86_400_000;

/**
 * The spots.md §2.2 numbers these reads use. `src/core/spots/constants.ts` holds the same ones
 * (`SPOT_WINDOW_DAYS`, `SPOT_MAX_DRIVES`, `SPOT_MAX_EVENTS`, `MIN_DRIVES_FOR_CARD`,
 * `CLEARED_SHOWN_DAYS`); they live here too so the data layer needs nothing at run time from the
 * spots feature.
 */
export const SPOT_READ = {
  /** Drives and events older than this are not read. */
  windowDays: 120,
  /** The newest scored drives in the window. */
  maxDrives: 400,
  /** The newest qualifying events in the window. */
  maxEvents: 3000,
  /** Scored drives in the window before the card shows. */
  minDrivesForCard: 10,
  /** Cleared spots are counted in the card's footnote this long. */
  clearedShownDays: 30,
} as const;

/** A spot as the screens read it (camelCase, the coloured road decoded). */
export interface ProblemSpot {
  id: string;
  kind: SpotKind;
  state: 'active' | 'cleared';
  pin: LatLng;
  headingDeg: number;
  segment: LatLng[];
  limitMph: number | null;
  hits: number;
  passes: number;
  recentHits: number;
  recentPasses: number;
  rate: number;
  cleanStreak: number;
  cleanNeeded: number;
  lastHitAt: number;
  lastHitTrip: string;
  lastPassAt: number;
  clearedAt: number | null;
  rank: number;
  label: string | null;
}

export interface SpotsView {
  /** Spots were computed at least once on this phone. */
  computed: boolean;
  /** Enough scored drives in the window for the card (`SPOT_READ.minDrivesForCard`). */
  eligible: boolean;
  /** Active spots in rank order. */
  active: ProblemSpot[];
  /** Spots cleared in the last `SPOT_READ.clearedShownDays` days. */
  clearedRecently: number;
}

/**
 * What the recompute job reads: the scored drives of the window with a route (the whole route where
 * the phone holds it), and their qualifying events (at their exact places where the phone holds them).
 */
export interface SpotInputs {
  drives: { clientTripId: string; startedAt: number; polyline: string }[];
  events: SpotEvent[];
}

export function toProblemSpot(row: ProblemSpotRow): ProblemSpot {
  let segment: LatLng[] = [];
  try {
    segment = decodePolyline(row.segment);
  } catch {
    segment = [];
  }
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    pin: { lat: row.lat, lng: row.lng },
    headingDeg: row.heading_deg,
    segment,
    limitMph: row.limit_mph,
    hits: row.hits,
    passes: row.passes,
    recentHits: row.recent_hits,
    recentPasses: row.recent_passes,
    rate: row.rate,
    cleanStreak: row.clean_streak,
    cleanNeeded: row.clean_needed,
    lastHitAt: row.last_hit_at,
    lastHitTrip: row.last_hit_trip,
    lastPassAt: row.last_pass_at,
    clearedAt: row.cleared_at,
    rank: row.rank,
    label: row.label,
  };
}

/** Every spot, active first by rank, then cleared. */
async function allSpots(db: Db): Promise<ProblemSpot[]> {
  return (await createSpotsRepo(db).list()).map(toProblemSpot);
}

/** The Analytics card's view of the spots at `now`. */
export async function readSpotsView(db: Db, now: number): Promise<SpotsView> {
  const meta = parseSpotsMeta(await createSettingsRepo(db).get<unknown>(SPOTS_META_KEY));
  const spots = await allSpots(db);
  const since = now - SPOT_READ.clearedShownDays * DAY_MS;
  return {
    computed: meta !== null,
    eligible: meta !== null && meta.drives >= SPOT_READ.minDrivesForCard,
    active: spots.filter((s) => s.state === 'active'),
    clearedRecently: spots.filter((s) => s.state === 'cleared' && s.clearedAt !== null && s.clearedAt >= since).length,
  };
}

/** The active spots the driving screen watches for. */
export async function readWatchSpots(db: Db): Promise<WatchSpot[]> {
  return (await allSpots(db))
    .filter((s) => s.state === 'active')
    .map((s) => ({ id: s.id, kind: s.kind, lat: s.pin.lat, lng: s.pin.lng, headingDeg: s.headingDeg }));
}

const SPOT_EVENT_TYPES: readonly SpotKind[] = ['speeding', 'hard_brake', 'hard_corner', 'hard_accel'];

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The recompute job's inputs at `now`: the newest 400 scored drives started in the last 120 days
 * that have a route, and the newest 3 000 events of theirs (`SPOT_READ`)
 * that can make a spot: active, not reported (or reported and turned down), one of the four kinds,
 * with a place (the exact one where the phone holds it, as `toLocalDriveEvent` reads it). "Wasn't
 * driving", recording, too-short and unscored drives are out.
 */
export async function readSpotInputs(db: Db, now: number): Promise<SpotInputs> {
  const since = now - SPOT_READ.windowDays * DAY_MS;
  const drives = (await readScoredDrives(db, since))
    .filter((d) => d.polyline !== null && d.polyline !== '')
    .slice(0, SPOT_READ.maxDrives)
    .map((d) => ({ clientTripId: d.clientTripId, startedAt: d.startedAt, polyline: d.polyline as string }));
  const kept = new Set(drives.map((d) => d.clientTripId));
  const { rows } = await db.execute(
    `SELECT e.id, e.client_trip_id, e.type, e.started_at, e.duration_s, e.measured_json,
            CASE WHEN e.lat_full IS NOT NULL AND e.lng_full IS NOT NULL THEN e.lat_full ELSE e.lat END AS lat,
            CASE WHEN e.lat_full IS NOT NULL AND e.lng_full IS NOT NULL THEN e.lng_full ELSE e.lng END AS lng
       FROM trip_events e JOIN trips t ON t.client_trip_id = e.client_trip_id
      WHERE e.status = 'active' AND e.dispute_status IN ('none', 'rejected')
        AND e.type IN ('speeding', 'hard_brake', 'hard_corner', 'hard_accel')
        AND ((e.lat_full IS NOT NULL AND e.lng_full IS NOT NULL) OR (e.lat IS NOT NULL AND e.lng IS NOT NULL))
        AND ${SCORED_TRIP} AND t.started_at >= ?
      ORDER BY e.started_at DESC, e.id DESC
      LIMIT ?`,
    [since, SPOT_READ.maxEvents]
  );
  const events: SpotEvent[] = [];
  for (const row of rows) {
    const clientTripId = asText(row, 'client_trip_id');
    const type = asText(row, 'type') as SpotKind;
    if (!kept.has(clientTripId) || !SPOT_EVENT_TYPES.includes(type)) continue;
    let measured: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(typeof row.measured_json === 'string' ? row.measured_json : 'null');
      if (typeof raw === 'object' && raw !== null) measured = raw as Record<string, unknown>;
    } catch {
      measured = {};
    }
    events.push({
      id: asText(row, 'id'),
      clientTripId,
      type,
      startedAt: asNumber(row, 'started_at'),
      durationS: asNumber(row, 'duration_s'),
      lat: asNumber(row, 'lat'),
      lng: asNumber(row, 'lng'),
      speedMph: finiteOrNull(measured.speedMph),
      limitMph: finiteOrNull(measured.limitMph),
    });
  }
  return { drives, events };
}

/** The spots view for the Analytics card and sheet; the last answer stays while a new one loads. */
export function useSpots(): UseQueryResult<SpotsView> {
  const { db, now } = useDataSource();
  return useQuery({ queryKey: queryKeys.spots(), queryFn: () => readSpotsView(db, now()), placeholderData: keepPreviousData });
}
