// The Overpass side of the road-layer fill (migration 0013): one query per 0.1° cell for the twelve
// drivable classes osm.ways holds, streamed and normalised into `osm_upsert_ways` rows.
//
//   * `out geom` prints each way's complete geometry (the sample run showed ways reaching outside
//     the bbox), so a way crossing a cell edge is stored whole, once, under its OSM id, whichever
//     cell loaded it first.
//   * Memory is bounded: the reply for a dense city cell is tens of megabytes, so `streamElements`
//     walks the body as it arrives and yields one element at a time; nothing holds the whole JSON.
//   * Overpass reports its own failures (a timed-out or out-of-memory query) as a 200 with a
//     `remark` after a partial `elements` array. The stream throws `OverpassRemark` at the end of
//     such a body, so a caller that already stored the partial batches still marks the cell failed
//     and it is fetched again later.
//   * The public mirrors are shared by everyone: a descriptive User-Agent, a hard abort, and the
//     caller's app-wide budget (`take_global_rate_limit`) keep this a polite client. The second
//     mirror is tried only when the first refused or failed before sending any element.
import type { BBox } from '../_shared/speedLimits/geometry';

export const OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export const OVERPASS_USER_AGENT = 'RoadWise speed-limits fill (Supabase edge function; OSM data under ODbL)';
/** The query's own server-side limit, and the client's abort a little past it. */
export const OVERPASS_TIMEOUT_S = 90;
export const OVERPASS_ABORT_MS = 100_000;

/** The road classes osm.ways accepts (migration 0002's CHECK), in the query's regex. */
export const HIGHWAY_CLASSES: readonly string[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];
const HIGHWAY_SET: ReadonlySet<string> = new Set(HIGHWAY_CLASSES);

/** One row of an `osm_upsert_ways` batch; `line` is `[lng, lat]` pairs, as GeoJSON orders them. */
export interface WayRow {
  id: number;
  highway: string;
  maxspeed_mph: number | null;
  maxspeed_raw: string | null;
  name: string | null;
  oneway: -1 | 0 | 1;
  line: [number, number][];
}

const fix = (n: number): number => Math.round(n * 1e7) / 1e7;

/**
 * The Overpass QL for one cell: anchored on the class list (`residential` must not catch a
 * `living_street`-like tag through a loose regex), `out geom` for the coordinates.
 */
export function overpassQuery(b: BBox): string {
  const bbox = [b.minLat, b.minLng, b.maxLat, b.maxLng].map(fix).join(',');
  return `[out:json][timeout:${OVERPASS_TIMEOUT_S}];way["highway"~"^(${HIGHWAY_CLASSES.join('|')})$"](${bbox});out geom;`;
}

const KMH_PER_MPH = 1.609344;
const MPH_PER_KNOT = 1.150779;

/**
 * An OSM `maxspeed` as whole mph in 5..85, or null for anything that is not one posted number:
 * "25 mph" → 25; a bare number or "50 km/h" is km/h (OSM's default unit) → 31; "none", "signals",
 * "walk", "variable", a country code such as "US:urban", a pair like "25 mph;35 mph", or junk → null.
 */
export function parseMaxspeed(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  let mph: number;
  let m = /^(\d+(?:\.\d+)?)\s*mph$/.exec(s);
  if (m) mph = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)\s*(?:km\/h|kmh|kph)?$/.exec(s))) mph = Number(m[1]) / KMH_PER_MPH;
  else if ((m = /^(\d+(?:\.\d+)?)\s*knots$/.exec(s))) mph = Number(m[1]) * MPH_PER_KNOT;
  else return null;
  const r = Math.round(mph);
  return r >= 5 && r <= 85 ? r : null;
}

/**
 * osm.ways' `oneway`: 1 along the digitised direction, -1 against it, 0 both ways. A reversible or
 * alternating road is two-way to the matcher. Untagged, a motorway or a roundabout is one-way by
 * OSM convention; anything else is two-way.
 */
export function parseOneway(tags: Record<string, unknown>): -1 | 0 | 1 {
  const v = typeof tags.oneway === 'string' ? tags.oneway.trim().toLowerCase() : '';
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v !== '') return 0;
  return tags.highway === 'motorway' || tags.junction === 'roundabout' || tags.junction === 'circular' ? 1 : 0;
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
};

/** One Overpass element as an upsert row, or null for anything but a drivable way with a line. */
export function toWayRow(el: unknown): WayRow | null {
  if (el === null || typeof el !== 'object') return null;
  const e = el as Record<string, unknown>;
  if (e.type !== 'way') return null;
  const id = e.id;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) return null;
  const tags = e.tags !== null && typeof e.tags === 'object' ? (e.tags as Record<string, unknown>) : {};
  const highway = tags.highway;
  if (typeof highway !== 'string' || !HIGHWAY_SET.has(highway)) return null;
  if (!Array.isArray(e.geometry)) return null;
  const line: [number, number][] = [];
  for (const p of e.geometry as unknown[]) {
    if (p === null || typeof p !== 'object') continue;
    const { lat, lon } = p as { lat?: unknown; lon?: unknown };
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    line.push([lon, lat]);
  }
  if (line.length < 2) return null;
  return {
    id,
    highway,
    maxspeed_mph: parseMaxspeed(tags.maxspeed),
    maxspeed_raw: text(tags.maxspeed, 64),
    name: text(tags.name, 128),
    oneway: parseOneway(tags),
    line,
  };
}

/** Overpass finished the body with a `remark` (its own runtime error): the elements are partial. */
export class OverpassRemark extends Error {
  constructor(readonly remark: string) {
    super(`overpass remark: ${remark}`);
    this.name = 'OverpassRemark';
  }
}

/** The mirror answered with a status that is not a reply (429, 504, …), before any element. */
export class OverpassRefused extends Error {
  constructor(readonly status: number) {
    super(`overpass answered ${status}`);
    this.name = 'OverpassRefused';
  }
}

/**
 * The objects of the reply's top-level `elements` array, one at a time, from a body of any chunking.
 * A brace-depth scan that honours strings (and escapes within them) finds each element's extent;
 * only that element is parsed, and the buffer never holds more than the element in progress plus
 * one chunk. After the array, the rest of the body is read for a `remark`.
 */
export async function* streamElements(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let inElements = false;
  let done = false;
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let pos = 0;
  let closed = false;
  while (!closed) {
    const chunk = await reader.read();
    done = chunk.done;
    buf += chunk.value ? decoder.decode(chunk.value, { stream: !done }) : decoder.decode();
    if (!inElements) {
      const i = buf.indexOf('"elements"');
      const j = i === -1 ? -1 : buf.indexOf('[', i);
      if (j === -1) {
        if (done) return;
        if (i === -1) buf = buf.slice(Math.max(0, buf.length - 16)); // the key may straddle chunks
        continue;
      }
      inElements = true;
      buf = buf.slice(j + 1);
      pos = 0;
    }
    while (pos < buf.length) {
      const ch = buf[pos];
      if (start === -1) {
        if (ch === '{') {
          start = pos;
          depth = 1;
          inStr = false;
          esc = false;
        } else if (ch === ']') {
          closed = true;
          pos += 1;
          break;
        }
        pos += 1;
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          yield JSON.parse(buf.slice(start, pos + 1));
          buf = buf.slice(pos + 1);
          pos = 0;
          start = -1;
          continue;
        }
      }
      pos += 1;
    }
    if (closed) {
      buf = buf.slice(pos);
      break;
    }
    if (start === -1) {
      buf = '';
    } else {
      buf = buf.slice(start);
      start = 0;
    }
    pos = buf.length;
    if (done) return;
  }
  // past the array: only the remark matters
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buf += chunk.value ? decoder.decode(chunk.value, { stream: !done }) : decoder.decode();
  }
  const m = /"remark"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf);
  if (m) throw new OverpassRemark(JSON.parse(`"${m[1]}"`) as string);
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Every drivable way of the box, as upsert rows, from the first mirror that answers. A mirror that
 * refuses (any non-2xx) or fails before its first element is skipped for the next; a failure after
 * elements have been yielded propagates (the caller has partial data, and marks the cell failed).
 */
export async function* fetchWays(
  box: BBox,
  opts: { fetch?: Fetch; endpoints?: readonly string[]; abortMs?: number } = {}
): AsyncGenerator<WayRow, void, undefined> {
  const doFetch = opts.fetch ?? fetch;
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS;
  const query = overpassQuery(box);
  let lastError: unknown = new Error('no overpass endpoint configured');
  for (const url of endpoints) {
    let yielded = false;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'user-agent': OVERPASS_USER_AGENT, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(opts.abortMs ?? OVERPASS_ABORT_MS),
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new OverpassRefused(res.status);
      }
      for await (const el of streamElements(res.body)) {
        const row = toWayRow(el);
        if (row) {
          yielded = true;
          yield row;
        }
      }
      return;
    } catch (err) {
      if (yielded) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
