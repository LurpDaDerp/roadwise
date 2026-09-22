// The parked simulation's speed-limit source (U5): an in-memory `SpeedLimitClient` over a fixture
// trace's corridor. The real client writes every tile it fetches to SQLite and asks the network;
// this one holds a list of points in memory and does neither, so a simulated drive can show a
// limit without touching the tile table or the edge function (rev1: m; ruling "Carried from H1").
//
// Developer tooling only: it is imported by the diagnostics screen and never by the drive host
// H2 builds for real drives.
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import { limitAt, type Trace } from '@/core/replay/trace';
import type { SpeedLimitClient } from '@/core/speedLimits/client';

/** A trace position counts as "on the corridor" within this distance (the design's 25 m match, rounded up). */
export const FAKE_MATCH_RADIUS_M = 30;

/**
 * How many lookups of a trip answer `null` ("tile not in memory yet") before the corridor answers.
 * It lets a parked test see the HUD's "—" before tiles, as a real drive starts (device pass 2).
 */
export const FAKE_TILE_DELAY_LOOKUPS = 3;

export interface CorridorPoint {
  lat: number;
  lng: number;
  limit: LimitSample;
}

/** Every trace row's position, with the limit the trace says was in force at that row. */
export function corridorOf(trace: Pick<Trace, 'rows' | 'limits'>): CorridorPoint[] {
  return trace.rows
    .filter((r) => r.gnssValid)
    .map((r) => ({ lat: r.lat, lng: r.lng, limit: limitAt(trace.limits, r.ts) }));
}

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const x = (bLng - aLng) * Math.cos(((aLat + bLat) / 2) * DEG) * M_PER_DEG;
  const y = (bLat - aLat) * M_PER_DEG;
  return Math.hypot(x, y);
}

export interface FakeLimitsOptions {
  tileDelayLookups?: number;
  radiusM?: number;
}

export function createFakeLimits(
  corridor: readonly CorridorPoint[],
  opts: FakeLimitsOptions = {}
): SpeedLimitClient {
  const delay = opts.tileDelayLookups ?? FAKE_TILE_DELAY_LOOKUPS;
  const radius = opts.radiusM ?? FAKE_MATCH_RADIUS_M;
  let lookupsThisTrip = 0;

  function nearest(lat: number, lng: number): LimitSample {
    let best: CorridorPoint | null = null;
    let bestM = Infinity;
    for (const p of corridor) {
      const m = metresBetween(lat, lng, p.lat, p.lng);
      if (m < bestM) {
        bestM = m;
        best = p;
      }
    }
    // Loaded, and no road with a limit here: the client's own "unknown" answer, not a guess.
    return best && bestM <= radius ? { ...best.limit } : { ...UNKNOWN_LIMIT };
  }

  return {
    lookup(lat, lng, _course, { gnssValid }) {
      if (!gnssValid) return null;
      lookupsThisTrip += 1;
      if (lookupsThisTrip <= delay) return null;
      return nearest(lat, lng);
    },
    // A dry-run host never calls these (H1 fix round, M2); they are inert here all the same.
    prefetch() {},
    startTrip() {},
    lookupStored: (lat, lng) => Promise.resolve(nearest(lat, lng)),
    resetTrip() {
      lookupsThisTrip = 0;
    },
    purgeExpired: () => Promise.resolve(0),
    stats: () => ({
      memoryTiles: corridor.length > 0 ? 1 : 0,
      requestsThisTrip: 0,
      pointLookupsThisTrip: 0,
      sqliteLoads: 0,
      truncatedTiles: 0,
    }),
    settled: () => Promise.resolve(),
  };
}
