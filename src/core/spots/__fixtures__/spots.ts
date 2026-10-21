/** Synthetic roads, drives and events around one place for the spots tests. */
import type { LatLng } from '@/lib/geo';

import type { SpotDrive, SpotEvent, SpotKind } from '../types';

export const DAY = 86_400_000;
/** Mon, Jun 1 2026, 00:00 UTC. */
export const T0 = Date.UTC(2026, 5, 1);

const BASE = { lat: 47.65, lng: -122.35 };
const M_LAT = 1 / ((Math.PI / 180) * 6371008.8);
const K = Math.cos((BASE.lat * Math.PI) / 180);

/** The point `north` metres north and `east` metres east of the base. */
export const at = (north: number, east: number): LatLng => ({ lat: BASE.lat + north * M_LAT, lng: BASE.lng + (east * M_LAT) / K });

/** A straight road from one [north, east] to another, a point every `step` metres. */
export function line(from: readonly [number, number], to: readonly [number, number], step = 20): LatLng[] {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.round(len / step));
  return Array.from({ length: n + 1 }, (_, i) => at(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n));
}

/** 2 km due north. */
export const NORTH = line([0, 0], [2000, 0]);
/** The same road driven south. */
export const SOUTH = [...NORTH].reverse();
/** A road 50 m east of it, also north. */
export const PARALLEL = line([0, 50], [2000, 50]);
/** North for 1 km, then a right turn east for 1 km. */
export const TURN = [...line([0, 0], [1000, 0]), ...line([1000, 20], [1000, 1000])];

export function drive(id: string, day: number, runs: readonly (readonly LatLng[])[] = [NORTH]): SpotDrive {
  return { clientTripId: id, startedAt: T0 + day * DAY, runs };
}

export function ev(id: string, d: SpotDrive, type: SpotKind, where: readonly [number, number], over: Partial<SpotEvent> = {}): SpotEvent {
  const p = at(where[0], where[1]);
  return {
    id,
    clientTripId: d.clientTripId,
    type,
    startedAt: d.startedAt + 5 * 60_000,
    durationS: type === 'speeding' ? 10 : 1,
    lat: p.lat,
    lng: p.lng,
    speedMph: type === 'speeding' ? 42 : 30,
    limitMph: type === 'speeding' ? 35 : null,
    ...over,
  };
}

/** Metres between two points (flat, plenty at this scale). */
export function metres(a: LatLng, b: LatLng): number {
  return Math.hypot((a.lat - b.lat) / M_LAT, ((a.lng - b.lng) * K) / M_LAT);
}

/** A seeded PRNG (mulberry32), for shuffles. */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
