// speed-limits: the posted speed limit where the car is (design §4.4; plan R5, R8; rev1: I6).
//
// Two routes, one function:
//
//   GET  ?tiles=15/x/y,…  (1..4 keys) → `TileBatchResponse`: `speed_limit_tiles`' JSON as the
//        database built it, plus `fallback: 'aws' | null` (`'aws'` iff the AWS client is configured
//        and at least one requested tile overlaps `AWS_COVERAGE`).
//        Validated against the device's own schema before it is sent: the device refuses a whole
//        batch for one bad segment, so a batch this end would send wrongly is a 500, never a
//        half-good 200. `truncated` is passed through as the database set it.
//        `Cache-Control: private, max-age=` up to the batch's earliest tile expiry, at most a day
//        (ruling B2-I1), and gzip when the request accepts it.
//   POST PointRequest → PointResponse, in §4.4's order: the candidates around the point go through
//        `matchLimit` (the device's matcher, byte for byte); a match with a limit answers. Otherwise,
//        with the AWS client configured, the point inside a state whose open data is loaded, and
//        neither the user's nor the global daily AWS budget spent, one `CalculateRoutes` call from a
//        random 75..200 m behind the car to a random 150..300 m ahead of it on the heading (ruling
//        B2 I-1: no stored line ends at a fixed offset from the car). Each span of the route with a
//        limit becomes the cache segment the device would see; the answer is used only if the
//        matcher picks one of them exactly as the device would from the tile. That span alone is
//        cached (only AWS's geometry and limit, for a random 7 to 10 whole days; the database
//        normalises its orientation) and answered `cached`. Everything else is `unknown`, with
//        confidence 0. An AWS failure is never a 5xx.
//
// Order of refusal, cheapest first: method, JWT, the request's shape, the route's budget, then the
// database. The uid comes from the token only. Each request logs one line,
// `{ requestId, route, outcome, source }`: never a coordinate, a heading or a tile key.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bearerToken,
  invalidPayload,
  json,
  pgFailure,
  readJsonBody,
  requestId,
  withRequestId,
  type Logger,
} from '../_shared/http.ts';
import { asPgError } from '../_shared/pg.ts';
import { nearestOnPolyline, type LatLng } from '../_shared/speedLimits/geometry';
import { matchLimit, type Candidate, type MatchResult } from '../_shared/speedLimits/match';
import { parseTileKey, tileBounds } from '../_shared/speedLimits/tiles';
import {
  PointRequestSchema,
  PointResponseSchema,
  ProviderSchema,
  TileBatchResponseSchema,
  TileKeysSchema,
  type PointResponse,
} from '../_shared/speedLimits/wire';
import type { RoutesClient, SpanLimit } from './aws.ts';

/**
 * Every rate-limit budget this function spends, in one place (B1 security audit; rulings B2 M-1,
 * M-2, F1). Each per-user budget is one `take_rate_limit(user, key, window, max)` row; the global
 * one is one `take_global_rate_limit(key, window, max)` row. handler.test.ts pins the values.
 *   aws:       AWS lookups per user per day. Each costs money, so a spent budget is `unknown`.
 *   awsGlobal: AWS lookups per day across every user (`AWS_GLOBAL_PER_DAY`), so N accounts cannot
 *              make 100·N paid calls. Spent or unreadable, it is `unknown`: the check fails closed.
 *   tiles:     tile batches per user per hour. The device asks for one batch per kilometre (about
 *              two a minute at highway speed), so 240 an hour is double that with room for retries.
 *   point:     point lookups per user per hour (429 when spent). The device asks at most one per
 *              prefetch window, about one a kilometre, so 600 an hour is far above any honest drive.
 */
export const AWS_GLOBAL_PER_DAY = 2000;
export const RATE_LIMITS = {
  aws: { key: 'aws_limits', window: '1 day', max: 100 },
  awsGlobal: { key: 'aws_global', window: '1 day', max: AWS_GLOBAL_PER_DAY },
  tiles: { key: 'speed_tiles', window: '1 hour', max: 240, retryAfterS: 600 },
  point: { key: 'speed_point', window: '1 hour', max: 600, retryAfterS: 60 },
} as const;

export interface CoverageBox {
  state: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * The states whose open data is loaded (ruling B2 M-1): AWS is asked only inside these boxes.
 * Outside them `unknown` is the honest answer anyway. Washington: the loaded data's extent clipped
 * at the state borders (rulings B3 concern 3, B2 r5 m1): Vancouver, WA (about 45.63) and Spokane
 * Valley / Liberty Lake (to about -117.1) are in; downtown Portland (about 45.52), BC north of 49°
 * and Post Falls, ID (about -116.95) are out. Add a state here when its import lands.
 */
export const AWS_COVERAGE: readonly CoverageBox[] = [
  { state: 'WA', minLat: 45.54, maxLat: 49.0, minLng: -124.73, maxLng: -117.03 },
];

/**
 * Areas inside a coverage box whose roads are not loaded (review r5 m2). A box cannot follow the
 * Columbia, so north Portland, OR (Hayden Island, Kenton, St Johns, PDX, about 45.58..45.61) sits
 * inside WA's box; it is carved out here. Vancouver's downtown (45.63) and Camas / Washougal (east
 * of -122.47) stay in; the thin Vancouver waterfront strip south of 45.62 is out with it.
 */
export const AWS_EXCLUDE: readonly CoverageBox[] = [
  { state: 'OR', minLat: 45.54, maxLat: 45.62, minLng: -122.8, maxLng: -122.47 },
];

type Box = Pick<CoverageBox, 'minLat' | 'maxLat' | 'minLng' | 'maxLng'>;
const holds = (b: Box, p: LatLng): boolean => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;

export const insideCoverage = (p: LatLng): boolean =>
  AWS_COVERAGE.some((b) => holds(b, p)) && !AWS_EXCLUDE.some((x) => holds(x, p));

/**
 * True when the z15 tile `key` overlaps a coverage box (touching edges count) somewhere outside the
 * exclusions: the overlap with some box is not wholly inside an excluded area.
 */
export function tileInCoverage(key: string): boolean {
  const t = parseTileKey(key);
  if (!t) return false;
  const tb = tileBounds(t);
  return AWS_COVERAGE.some((b) => {
    const o: Box = {
      minLat: Math.max(tb.minLat, b.minLat),
      maxLat: Math.min(tb.maxLat, b.maxLat),
      minLng: Math.max(tb.minLng, b.minLng),
      maxLng: Math.min(tb.maxLng, b.maxLng),
    };
    if (o.minLat > o.maxLat || o.minLng > o.maxLng) return false;
    return !AWS_EXCLUDE.some(
      (x) => o.minLat >= x.minLat && o.maxLat <= x.maxLat && o.minLng >= x.minLng && o.maxLng <= x.maxLng
    );
  });
}

/** AWS cache rows live a random 7 to 10 whole days (B1 security audit), never a client-given time. */
export const AWS_TTL_MIN_DAYS = 7;
export const AWS_TTL_MAX_DAYS = 10;
/**
 * The AWS route runs from a random distance behind the car (on the reverse heading) to a random
 * distance ahead (ruling B2 I-1), so neither end of a stored line sits at a fixed offset from it.
 */
export const AWS_BEHIND_M = { min: 75, max: 200 } as const;
export const AWS_AHEAD_M = { min: 150, max: 300 } as const;
/** The tile call is abandoned after this; the migration's own statement timeout bounds the database. */
export const TILE_RPC_TIMEOUT_MS = 5_000;
/** A point request is four numbers; anything larger is not one. */
export const MAX_BODY_BYTES = 1_024;
/** The longest a batch may sit in an HTTP cache (rev1: O12), whatever its tiles' expiry. */
export const TILE_MAX_AGE_S = 86_400;

/**
 * The batch's `Cache-Control` (ruling B2-I1): never cached past the earliest tile expiry in it, so
 * a cache row's refresh (or its expiry) is never hidden behind a stale HTTP copy; at most a day.
 * `max(0, floor((min(expiresAt) - now) / 1000))`, capped at `TILE_MAX_AGE_S`.
 */
export function tileCacheControl(expiresAt: readonly number[], nowMs: number): string {
  const earliest = Math.min(...expiresAt);
  const age = Math.min(TILE_MAX_AGE_S, Math.max(0, Math.floor((earliest - nowMs) / 1000)));
  return `private, max-age=${age}`;
}

const M_PER_DEG = 111_320;
const DEG = Math.PI / 180;

export interface CacheWrite {
  /** A stable identity of the road AWS answered for; `put_limits_cache` hashes it into the row key. */
  key: string;
  leg: LatLng[];
  limitMph: number;
  /** Set only for a one-way road; null stores a row the matcher accepts in both directions. */
  headingDeg: number | null;
  ttlDays: number;
}

/** The database port. Everything runs under the service role; the functions are service-role only. */
export interface SpeedLimitsDb {
  candidates(lat: number, lng: number, radiusM: number): Promise<Candidate[]>;
  /** `speed_limit_tiles` verbatim; the handler validates it. */
  tiles(keys: string[]): Promise<unknown>;
  takeRateLimit(userId: string, key: string, window: string, max: number): Promise<boolean>;
  /** The app-wide budget row (`take_global_rate_limit`), shared by every user. */
  takeGlobalRateLimit(key: string, window: string, max: number): Promise<boolean>;
  /** The stored (hashed) key. */
  putLimitsCache(write: CacheWrite): Promise<string>;
}

/** The tile call ran past `TILE_RPC_TIMEOUT_MS`. */
export class TileTimeout extends Error {
  constructor() {
    super('speed_limit_tiles timed out');
    this.name = 'TileTimeout';
  }
}

type Row = Record<string, unknown>;

/**
 * One candidate row narrowed to the matcher's `Candidate`, or null for a row the contract cannot
 * describe (drift, dropped rather than guessed). The generated types are looser than the data:
 * `limit_mph` is null for an untagged OSM way, and a missing bearing becomes NaN, which the matcher
 * refuses. The key is `${provider}:${segment_key}`, exactly as the device builds it from a tile id.
 */
export function toCandidate(row: Row): Candidate | null {
  const provider = ProviderSchema.safeParse(row.provider);
  if (!provider.success) return null;
  const key = row.segment_key;
  if (typeof key !== 'string' || key.length === 0) return null;
  const oneway = row.oneway;
  if (oneway !== -1 && oneway !== 0 && oneway !== 1) return null;
  const distanceM = row.distance_m;
  if (typeof distanceM !== 'number' || !Number.isFinite(distanceM)) return null;
  const limit = row.limit_mph;
  const bearing = row.bearing_deg;
  return {
    provider: provider.data,
    key: `${provider.data}:${key}`,
    limitMph: typeof limit === 'number' && Number.isInteger(limit) ? limit : null,
    highway: typeof row.highway === 'string' ? row.highway : '',
    oneway,
    distanceM,
    bearingDeg: typeof bearing === 'number' && Number.isFinite(bearing) ? bearing : NaN,
  };
}

export function createSpeedLimitsDb(client: SupabaseClient, log: Logger = console): SpeedLimitsDb {
  return {
    async candidates(lat, lng, radiusM) {
      const { data, error } = await client.rpc('speed_limit_candidates', { p_lat: lat, p_lng: lng, p_radius_m: radiusM });
      if (error) throw asPgError(error);
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const out = rows.map(toCandidate).filter((c): c is Candidate => c !== null);
      if (out.length !== rows.length) log.warn('speed-limits dropped candidate rows', { dropped: rows.length - out.length });
      return out;
    },
    async tiles(keys) {
      const signal = AbortSignal.timeout(TILE_RPC_TIMEOUT_MS);
      const { data, error } = await client.rpc('speed_limit_tiles', { p_keys: keys }).abortSignal(signal);
      if (signal.aborted) throw new TileTimeout();
      if (error) throw asPgError(error);
      return data;
    },
    async takeRateLimit(userId, key, window, max) {
      const { data, error } = await client.rpc('take_rate_limit', {
        p_user: userId,
        p_key: key,
        p_window: window,
        p_max: max,
      });
      if (error) throw asPgError(error);
      return data === true;
    },
    async takeGlobalRateLimit(key, window, max) {
      const { data, error } = await client.rpc('take_global_rate_limit', { p_key: key, p_window: window, p_max: max });
      if (error) throw asPgError(error);
      return data === true;
    },
    async putLimitsCache(w) {
      const { data, error } = await client.rpc('put_limits_cache', {
        p_key: w.key,
        p_line: { type: 'LineString', coordinates: w.leg.map((p) => [p.lng, p.lat]) },
        p_limit_mph: w.limitMph,
        // The generated type says number; the function takes null (a two-way row).
        p_heading: w.headingDeg as number,
        p_ttl_days: w.ttlDays,
      });
      if (error) throw asPgError(error);
      return String(data);
    },
  };
}

export interface SpeedLogger extends Logger {
  info(...args: unknown[]): void;
}

export interface SpeedLimitsDeps {
  /** The user id the token proves, or null when it proves nothing. */
  verifyJwt(token: string): Promise<string | null>;
  db: SpeedLimitsDb;
  /** Null when the three AWS secrets are not all set: no fallback, `fallback: null`. */
  routes: RoutesClient | null;
  log?: SpeedLogger;
  /** For the route's ends and the cache TTL; `Math.random` by default. */
  random?: () => number;
  /** Epoch ms, for the batch's max-age; `Date.now` by default. */
  now?: () => number;
}

type Route = 'point' | 'tiles';

/** A point `metres` from `p` along the compass bearing `deg`, on the flat projection the matcher uses. */
export function ahead(p: LatLng, deg: number, metres: number): LatLng {
  const r = deg * DEG;
  return {
    lat: p.lat + (metres * Math.cos(r)) / M_PER_DEG,
    lng: p.lng + (metres * Math.sin(r)) / (M_PER_DEG * Math.max(Math.cos(p.lat * DEG), 1e-6)),
  };
}

/** A whole number of days, uniform over 7..10. */
export function cacheTtlDays(random: () => number): number {
  const span = AWS_TTL_MAX_DAYS - AWS_TTL_MIN_DAYS + 1;
  const d = AWS_TTL_MIN_DAYS + Math.floor(random() * span);
  return Math.min(AWS_TTL_MAX_DAYS, Math.max(AWS_TTL_MIN_DAYS, d));
}

const fix5 = (p: LatLng): string => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * The cache identity of an AWS answer. The geo-routes v2 span carries no road or segment id, so it
 * is the snapped leg AWS returned (its point count and both ends), never the query origin: two roads
 * near one point (an overpass) snap to different legs and never share a row.
 *
 * The ends are put in canonical order first (the one that sorts first by lng, then by lat, leads),
 * the order `put_limits_cache` stores the line in. The database serves the key's hash as the tile
 * segment id, so a key in travel order would let anyone who decodes the line hash both orders and
 * learn which way the car went (security finding X-I1). A leg and its reverse share one key.
 */
export function awsCacheKey(leg: readonly LatLng[]): string {
  const a = leg[0]!;
  const b = leg[leg.length - 1]!;
  const aFirst = a.lng < b.lng || (a.lng === b.lng && a.lat <= b.lat);
  const [first, last] = aFirst ? [a, b] : [b, a];
  return `aws:${leg.length}:${fix5(first)};${fix5(last)}`;
}

async function sha16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** The AWS answer as the cache segment the device will see in its tile (two-way, as stored). */
async function awsCandidate(p: LatLng, found: SpanLimit, key: string): Promise<Candidate> {
  const line = new Float64Array(found.leg.length * 2);
  found.leg.forEach((q, i) => {
    line[2 * i] = q.lat;
    line[2 * i + 1] = q.lng;
  });
  const near = nearestOnPolyline(p, line);
  return {
    provider: 'aws',
    // The id `put_limits_cache` will store: left(sha256(key), 16), so a tie breaks as on the device.
    key: `aws:${await sha16(key)}`,
    limitMph: found.mph,
    highway: 'road',
    oneway: 0,
    distanceM: near.distanceM,
    bearingDeg: near.bearingDeg,
  };
}

const unknownAnswer = (parallelRoads: boolean): PointResponse => ({
  source: 'unknown',
  limitMph: null,
  matchConfidence: 0,
  parallelRoads,
  provider: null,
});

const toAnswer = (m: MatchResult): PointResponse =>
  m.source === 'unknown'
    ? unknownAnswer(m.parallelRoads)
    : m.source === 'posted'
      ? { source: 'posted', limitMph: m.limitMph, matchConfidence: m.matchConfidence, parallelRoads: m.parallelRoads, provider: m.provider }
      : { source: 'cached', limitMph: m.limitMph, matchConfidence: m.matchConfidence, parallelRoads: m.parallelRoads, provider: 'aws' };

/** True when the request's Accept-Encoding allows gzip (a `q=0` refuses it). */
export function acceptsGzip(req: Request): boolean {
  const header = req.headers.get('accept-encoding') ?? '';
  return header.split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * A JSON reply, gzip-encoded here when the caller accepts it (rev1: O12). Done explicitly: checked
 * on Deno 2.9.6, `Deno.serve` sent a 2 KB JSON body to an `Accept-Encoding: gzip` request
 * uncompressed, and passed a body that already carries `content-encoding` through untouched, so
 * nothing downstream in the function compresses twice. Whether Supabase's gateway would compress
 * is not something this code should depend on.
 */
async function jsonEncoded(req: Request, status: number, body: unknown, headers: Record<string, string>): Promise<Response> {
  const text = JSON.stringify(body);
  const common = { 'content-type': 'application/json', vary: 'Accept-Encoding', ...headers };
  if (!acceptsGzip(req)) return new Response(text, { status, headers: common });
  const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  return new Response(bytes, { status, headers: { ...common, 'content-encoding': 'gzip' } });
}

interface Run {
  deps: SpeedLimitsDeps;
  log: SpeedLogger;
  id: string;
  userId: string;
}

interface Outcome {
  res: Response;
  outcome: string;
  source: string | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

async function tiles(req: Request, run: Run): Promise<Outcome> {
  const { deps, log, id } = run;
  const url = new URL(req.url);
  const keys = url.searchParams.getAll('tiles').flatMap((v) => v.split(','));
  const parsed = TileKeysSchema.safeParse(keys);
  if (!parsed.success) return { res: invalidPayload(parsed.error), outcome: 'invalid', source: null };

  const b = RATE_LIMITS.tiles;
  if (!(await deps.db.takeRateLimit(run.userId, b.key, b.window, b.max))) {
    return {
      res: json(429, { code: 'too_many_requests' }, { 'retry-after': String(b.retryAfterS) }),
      outcome: 'rate_limited',
      source: null,
    };
  }

  const raw = await deps.db.tiles(parsed.data);
  // A point lookup can reach AWS only inside coverage (ruling B2 F2), so the batch promises the
  // fallback only when the client is configured and some requested tile overlaps a coverage box.
  const fallback = deps.routes && parsed.data.some(tileInCoverage) ? 'aws' : null;
  const batch = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Row), fallback } : raw;
  const checked = TileBatchResponseSchema.safeParse(batch);
  const inOrder =
    checked.success &&
    checked.data.tiles.length === parsed.data.length &&
    checked.data.tiles.every((t, i) => t.tile === parsed.data[i]);
  if (!checked.success || !inOrder) {
    // Paths and messages only: no value from the batch (a tile key, a line) reaches the log.
    log.error('speed-limits tile batch broke the contract', {
      requestId: id,
      route: 'tiles',
      issues: checked.success ? ['tiles do not answer the keys asked, in order'] : checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return { res: json(500, { code: 'invalid_tiles' }), outcome: 'invalid_tiles', source: null };
  }
  const cacheControl = tileCacheControl(checked.data.tiles.map((t) => t.expiresAt), (deps.now ?? Date.now)());
  const res = await jsonEncoded(req, 200, checked.data, { 'cache-control': cacheControl });
  return { res, outcome: 'served', source: null };
}

async function point(req: Request, run: Run): Promise<Outcome> {
  const { deps, log, id, userId } = run;
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return { res: body.response, outcome: 'invalid', source: null };
  const parsed = PointRequestSchema.safeParse(body.body);
  if (!parsed.success) return { res: invalidPayload(parsed.error), outcome: 'invalid', source: null };
  const { lat, lng, heading, radiusM } = parsed.data;
  const here = { lat, lng };

  const answer = (a: PointResponse, outcome: string): Outcome => {
    const valid = PointResponseSchema.safeParse(a);
    if (!valid.success) {
      log.error('speed-limits point answer broke the contract', { requestId: id, route: 'point' });
      return { res: json(500, { code: 'internal' }), outcome: 'invalid_answer', source: null };
    }
    return { res: json(200, valid.data), outcome, source: valid.data.source };
  };

  const pb = RATE_LIMITS.point;
  if (!(await deps.db.takeRateLimit(userId, pb.key, pb.window, pb.max))) {
    return {
      res: json(429, { code: 'too_many_requests' }, { 'retry-after': String(pb.retryAfterS) }),
      outcome: 'rate_limited',
      source: null,
    };
  }

  const candidates = await deps.db.candidates(lat, lng, radiusM);
  const match = matchLimit(heading, candidates);
  if (match.source !== 'unknown') return answer(toAnswer(match), 'matched');

  const unknown = (outcome: string) => answer(unknownAnswer(match.parallelRoads), outcome);
  if (!deps.routes) return unknown('no_fallback');
  if (!insideCoverage(here)) return unknown('outside_coverage');

  // The user's budget first, so a user whose own budget is spent never draws on everyone's.
  const { aws, awsGlobal } = RATE_LIMITS;
  const budgets = [
    [aws.key, 'rate_limited', () => deps.db.takeRateLimit(userId, aws.key, aws.window, aws.max)],
    [awsGlobal.key, 'global_rate_limited', () => deps.db.takeGlobalRateLimit(awsGlobal.key, awsGlobal.window, awsGlobal.max)],
  ] as const;
  for (const [key, refused, take] of budgets) {
    try {
      if (!(await take())) return unknown(refused);
    } catch (err) {
      log.error('speed-limits aws budget check failed', { requestId: id, route: 'point', budget: key, error: errorText(err) });
      return unknown('rate_limit_failed');
    }
  }

  const random = deps.random ?? Math.random;
  const between = (r: { min: number; max: number }): number => r.min + random() * (r.max - r.min);
  const from = ahead(here, heading + 180, between(AWS_BEHIND_M));
  const to = ahead(here, heading, between(AWS_AHEAD_M));
  let spans: SpanLimit[];
  try {
    spans = await deps.routes.speedLimitsAlong(from, to);
  } catch (err) {
    log.error('speed-limits aws lookup failed', { requestId: id, route: 'point', error: errorText(err) });
    return unknown('aws_failed');
  }
  if (spans.length === 0) return unknown('aws_no_limit');

  // The matcher decides, with every span of the route beside the open data, exactly as the device
  // will decide from the tile once the row is stored: it picks the span the car is on, and a route
  // that snapped to another road, or runs across the car's course, answers nothing.
  const keyed = await Promise.all(
    spans.map(async (span) => {
      const cacheKey = awsCacheKey(span.leg);
      return { span, cacheKey, candidate: await awsCandidate(here, span, cacheKey) };
    })
  );
  const withAws = matchLimit(heading, [...candidates, ...keyed.map((k) => k.candidate)]);
  const chosen = withAws.source === 'cached' ? keyed.find((k) => k.candidate.key === withAws.key) : undefined;
  if (!chosen) return unknown('aws_unmatched');
  // A pick the matcher could only make beside a differing limit within reach (a limit change at
  // the car, or a neighbouring road) is answered at its lowered confidence but never cached: the
  // row alone would later read from the tile at full cache confidence with no parallel flag, up to
  // 25 m into the neighbouring limit's zone (re-review N1). It also stores less route near the car.
  if (withAws.parallelRoads) return answer(toAnswer(withAws), 'aws_parallel_uncached');

  try {
    await deps.db.putLimitsCache({
      key: chosen.cacheKey,
      leg: chosen.span.leg,
      limitMph: chosen.span.mph,
      // The geo-routes v2 span says nothing about one-way travel, so the row is stored two-way.
      headingDeg: null,
      ttlDays: cacheTtlDays(random),
    });
  } catch (err) {
    // AWS did answer for this road; the answer stands, only the cache missed it.
    log.error('speed-limits aws cache write failed', { requestId: id, route: 'point', error: errorText(err) });
    return answer(toAnswer(withAws), 'aws_uncached');
  }
  return answer(toAnswer(withAws), 'aws');
}

export async function handleSpeedLimits(req: Request, deps: SpeedLimitsDeps): Promise<Response> {
  const log = deps.log ?? console;
  const id = requestId();
  const route: Route | null = req.method === 'GET' ? 'tiles' : req.method === 'POST' ? 'point' : null;
  const finish = (o: Outcome): Response => {
    log.info('speed-limits', { requestId: id, route, outcome: o.outcome, source: o.source });
    return withRequestId(o.res, id);
  };

  if (!route) {
    return finish({ res: json(405, { code: 'method_not_allowed' }, { allow: 'GET, POST' }), outcome: 'method_not_allowed', source: null });
  }

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyJwt(token);
    } catch (err) {
      log.error('speed-limits token check failed', { requestId: id, route, error: errorText(err) });
      return finish({ res: json(503, { code: 'retry' }, { 'retry-after': '2' }), outcome: 'auth_unavailable', source: null });
    }
  }
  if (!userId) return finish({ res: json(401, { code: 'unauthorized' }), outcome: 'unauthorized', source: null });

  const run: Run = { deps, log, id, userId };
  try {
    return finish(route === 'tiles' ? await tiles(req, run) : await point(req, run));
  } catch (err) {
    if (err instanceof TileTimeout) {
      log.error('speed-limits tile call timed out', { requestId: id, route });
      return finish({ res: json(503, { code: 'retry' }, { 'retry-after': '2' }), outcome: 'timeout', source: null });
    }
    return finish({ res: pgFailure(err, log, { requestId: id, route }, 'speed-limits'), outcome: 'error', source: null });
  }
}
