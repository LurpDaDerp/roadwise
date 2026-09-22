// Decoded speed-limit tiles in memory, and the LRU that holds them (plan rev1: I7).
//
// DEVICE ONLY. Not mirrored to the edge function: `scripts/sync-scoring.js` copies `wire`, `tiles`,
// `geometry` and `match` by explicit list, and this file must never join that list.
//
// Memory is the constraint: this runs in a background process during every drive, where iOS
// jetsam kills an app long before it would a foreground one. So a tile is decoded ONCE — whether
// it came from the network or from SQLite — into a handful of flat typed arrays (every segment's
// vertices in one `Float64Array`, their bounding boxes in another), not into `{lat, lng}` objects,
// and at most `MEMORY_TILES` of them are held. A lookup prefilters segments on their boxes and
// only measures the few near the car.

import type { BBox, LatLng } from './geometry';
import { bboxOf, decodeLine, nearBBox, nearestOnPolyline } from './geometry';
import type { Candidate } from './match';
import { parseTileKey, tileBounds } from './tiles';
import { type LimitSegment, LimitSegmentSchema, type Provider } from './wire';

/** Decoded tiles held in memory (rev1: I7 — about 9–12; 64 was tens of MB of heap). */
export const MEMORY_TILES = 12;

/** Segments are clipped to their tile with a 30 m buffer (B1), so they can reach past its edge. */
const TILE_BUFFER_M = 30;

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

/** One tile's segments, packed. Segment `i` owns `coords[offsets[i] .. offsets[i + 1])`. */
export interface DecodedTile {
  key: string;
  /** Epoch ms; the tile is stale from this instant. */
  expiresAt: number;
  /** The tile's own extent (segments may reach `TILE_BUFFER_M` beyond it). */
  bounds: BBox;
  /**
   * The server cut this tile at `MAX_SEGMENTS_PER_TILE`. Its cut order is not spatial, so any road
   * may be missing — including the car's own, next to a surviving parallel road.
   */
  truncated: boolean;
  count: number;
  /** `osm:<id>` etc. — the matcher's candidate key, so one road clipped into two tiles dedupes. */
  keys: string[];
  providers: Provider[];
  highways: string[];
  /** The limit in mph, 0 for an untagged road. */
  limits: Uint8Array;
  oneways: Int8Array;
  offsets: Uint32Array;
  /** `[lat0, lng0, lat1, lng1, …]` for every segment, back to back. */
  coords: Float64Array;
  /** `[minLat, minLng, maxLat, maxLng]` per segment. */
  boxes: Float64Array;
}

interface Unpacked {
  seg: LimitSegment;
  line: Float64Array;
}

/**
 * What a tile row stores in `segments_json`: the segments plus the server's `truncated` flag, in
 * one envelope, so the flag survives without a schema change. Rows written before the envelope
 * are a plain segment array and read as not truncated.
 */
export interface StoredTilePayload {
  truncated: boolean;
  segments: unknown[];
}

/** The segments and flag of a stored row, or null for a corrupt one. */
export function readStoredPayload(payload: unknown): StoredTilePayload | null {
  if (Array.isArray(payload)) return { truncated: false, segments: payload };
  if (payload !== null && typeof payload === 'object') {
    const { truncated, segments } = payload as { truncated?: unknown; segments?: unknown };
    if (typeof truncated === 'boolean' && Array.isArray(segments)) return { truncated, segments };
  }
  return null;
}

/**
 * Decode one tile's segments. A segment that fails the contract or whose polyline will not decode
 * is dropped on its own, so one bad segment never costs the whole tile.
 *
 * `trusted` skips the per-segment schema check for segments that were just validated as part of a
 * `TileBatchResponse`; rows read back from SQLite are always re-checked (they may predate this
 * build). `payload` is a `StoredTilePayload` or a legacy plain segment array. Returns null for a
 * corrupt payload — treated as absent.
 */
export function decodeTile(
  key: string,
  expiresAt: number,
  payload: unknown,
  trusted = false
): DecodedTile | null {
  const xy = parseTileKey(key);
  const stored = readStoredPayload(payload);
  if (!xy || !stored) return null;
  const { segments } = stored;

  const kept: Unpacked[] = [];
  let total = 0;
  for (const raw of segments) {
    let seg: LimitSegment;
    if (trusted) {
      seg = raw as LimitSegment;
    } else {
      const parsed = LimitSegmentSchema.safeParse(raw);
      if (!parsed.success) continue;
      seg = parsed.data;
    }
    let line: Float64Array;
    try {
      line = decodeLine(seg.line);
    } catch {
      continue;
    }
    kept.push({ seg, line });
    total += line.length;
  }

  const count = kept.length;
  const tile: DecodedTile = {
    key,
    expiresAt,
    bounds: tileBounds(xy),
    truncated: stored.truncated,
    count,
    keys: new Array<string>(count),
    providers: new Array<Provider>(count),
    highways: new Array<string>(count),
    limits: new Uint8Array(count),
    oneways: new Int8Array(count),
    offsets: new Uint32Array(count + 1),
    coords: new Float64Array(total),
    boxes: new Float64Array(count * 4),
  };
  let at = 0;
  kept.forEach(({ seg, line }, i) => {
    tile.keys[i] = `${seg.provider}:${seg.id}`;
    tile.providers[i] = seg.provider;
    tile.highways[i] = seg.highway;
    tile.limits[i] = seg.limitMph ?? 0;
    tile.oneways[i] = seg.oneway;
    tile.offsets[i] = at;
    tile.coords.set(line, at);
    at += line.length;
    const b = bboxOf(line);
    tile.boxes.set([b.minLat, b.minLng, b.maxLat, b.maxLng], i * 4);
  });
  tile.offsets[count] = at;
  return tile;
}

/**
 * Every segment within `radiusM` of `p` (by its box) across `tiles`, measured, as matcher
 * candidates. A road clipped into several tiles appears once, at its nearest distance.
 */
export function candidatesNear(tiles: Iterable<DecodedTile>, p: LatLng, radiusM: number): Candidate[] {
  const dLat = radiusM / M_PER_DEG;
  const dLng = radiusM / (Math.max(Math.cos(p.lat * DEG), 1e-6) * M_PER_DEG);
  const best = new Map<string, Candidate>();

  for (const t of tiles) {
    if (!nearBBox(p, t.bounds, radiusM + TILE_BUFFER_M)) continue;
    const { boxes } = t;
    for (let i = 0; i < t.count; i += 1) {
      const j = i * 4;
      if (
        p.lat < (boxes[j] as number) - dLat ||
        p.lng < (boxes[j + 1] as number) - dLng ||
        p.lat > (boxes[j + 2] as number) + dLat ||
        p.lng > (boxes[j + 3] as number) + dLng
      ) {
        continue;
      }
      const line = t.coords.subarray(t.offsets[i], t.offsets[i + 1]);
      const { distanceM, bearingDeg } = nearestOnPolyline(p, line);
      if (!(distanceM <= radiusM)) continue;
      const key = t.keys[i] as string;
      const prev = best.get(key);
      if (prev && prev.distanceM <= distanceM) continue;
      const limit = t.limits[i] as number;
      best.set(key, {
        provider: t.providers[i] as Provider,
        key,
        limitMph: limit === 0 ? null : limit,
        highway: t.highways[i] as string,
        oneway: t.oneways[i] as -1 | 0 | 1,
        distanceM,
        bearingDeg,
      });
    }
  }
  return [...best.values()];
}

/**
 * True when any tile whose area (with its buffer) reaches within `radiusM` of `p` is truncated:
 * the road the car is on may be one the server dropped, so no match here may be confident.
 */
export function truncatedNear(tiles: Iterable<DecodedTile>, p: LatLng, radiusM: number): boolean {
  for (const t of tiles) if (t.truncated && nearBBox(p, t.bounds, radiusM + TILE_BUFFER_M)) return true;
  return false;
}

/** A least-recently-used map of decoded tiles. `get` counts as a use; `peek` does not. */
export interface TileLru {
  get(key: string): DecodedTile | undefined;
  peek(key: string): DecodedTile | undefined;
  set(tile: DecodedTile): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
  values(): IterableIterator<DecodedTile>;
}

export function createTileLru(capacity: number = MEMORY_TILES): TileLru {
  // A Map iterates in insertion order, so re-inserting on use keeps the oldest first.
  const map = new Map<string, DecodedTile>();
  return {
    get(key) {
      const t = map.get(key);
      if (t) {
        map.delete(key);
        map.set(key, t);
      }
      return t;
    },
    peek: (key) => map.get(key),
    set(tile) {
      map.delete(tile.key);
      map.set(tile.key, tile);
      while (map.size > capacity) {
        const oldest = map.keys().next().value as string;
        map.delete(oldest);
      }
    },
    delete: (key) => void map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
    values: () => map.values(),
  };
}
