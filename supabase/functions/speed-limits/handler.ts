// speed-limits: the posted speed limit where the car is (design §4.4; plan R5, R8; rev1: I6).
//
// Two routes, one function:
//
//   GET  ?tiles=15/x/y,…  (1..4 keys) → `TileBatchResponse`: `speed_limit_tiles`' JSON as the
//        database built it, plus `fallback: 'aws' | null` (`'aws'` iff the AWS client is configured).
//        Validated against the device's own schema before it is sent: the device refuses a whole
//        batch for one bad segment, so a batch this end would send wrongly is a 500, never a
//        half-good 200. `truncated` is passed through as the database set it.
//        `Cache-Control: private, max-age=86400`, and gzip when the request accepts it.
//   POST PointRequest → PointResponse, in §4.4's order: the candidates around the point go through
//        `matchLimit` (the device's matcher, byte for byte); a match with a limit answers. Otherwise,
//        with the AWS client configured and the user's daily AWS budget not spent, one
//        `CalculateRoutes` call from the point to a point 150 m ahead on the heading. Its answer is
//        used only if the matcher, given the route's own geometry as a cache segment, picks it
//        exactly as the device would pick it from the tile; then it is cached (only AWS's geometry
//        and limit, for a random 7 to 10 whole days) and answered `cached`. Everything else is
//        `unknown`, with confidence 0. An AWS failure is never a 5xx.
//
// Order of refusal, cheapest first: method, JWT, the request's shape, the budget, then the
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
import {
  PointRequestSchema,
  PointResponseSchema,
  ProviderSchema,
  TileBatchResponseSchema,
  TileKeysSchema,
  type PointResponse,
} from '../_shared/speedLimits/wire';
import type { RoutesClient, SpeedLimitAlong } from './aws.ts';

/**
 * Every rate-limit budget this function spends, in one place (B1 security audit). Each is one
 * `take_rate_limit(uid, key, window, max)` row per user; handler.test.ts pins the values.
 *   aws:   AWS lookups per user per day. Each costs money, so a spent budget is `unknown`, not an error.
 *   tiles: tile batches per user per hour. The device asks for one batch per kilometre (about two a
 *          minute at highway speed), so 240 an hour is double that with room for retries.
 */
export const RATE_LIMITS = {
  aws: { key: 'aws_limits', window: '1 day', max: 100 },
  tiles: { key: 'speed_tiles', window: '1 hour', max: 240, retryAfterS: 600 },
} as const;

/** AWS cache rows live a random 7 to 10 whole days (B1 security audit), never a client-given time. */
export const AWS_TTL_MIN_DAYS = 7;
export const AWS_TTL_MAX_DAYS = 10;
/** How far ahead on the heading the AWS route ends (plan B2). */
export const AWS_AHEAD_M = 150;
/** The tile call is abandoned after this; the migration's own statement timeout bounds the database. */
export const TILE_RPC_TIMEOUT_MS = 5_000;
/** A point request is four numbers; anything larger is not one. */
export const MAX_BODY_BYTES = 1_024;
export const TILE_CACHE_CONTROL = 'private, max-age=86400';

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
  /** For the cache TTL; `Math.random` by default. */
  random?: () => number;
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
 */
export function awsCacheKey(leg: readonly LatLng[]): string {
  return `aws:${leg.length}:${fix5(leg[0]!)};${fix5(leg[leg.length - 1]!)}`;
}

async function sha16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** The AWS answer as the cache segment the device will see in its tile (two-way, as stored). */
async function awsCandidate(p: LatLng, found: SpeedLimitAlong, key: string): Promise<Candidate> {
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
  const batch =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Row), fallback: deps.routes ? 'aws' : null }
      : raw;
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
  const res = await jsonEncoded(req, 200, checked.data, { 'cache-control': TILE_CACHE_CONTROL });
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

  const candidates = await deps.db.candidates(lat, lng, radiusM);
  const match = matchLimit(heading, candidates);
  if (match.source !== 'unknown') return answer(toAnswer(match), 'matched');

  const unknown = (outcome: string) => answer(unknownAnswer(match.parallelRoads), outcome);
  if (!deps.routes) return unknown('no_fallback');

  const b = RATE_LIMITS.aws;
  try {
    if (!(await deps.db.takeRateLimit(userId, b.key, b.window, b.max))) return unknown('rate_limited');
  } catch (err) {
    log.error('speed-limits aws budget check failed', { requestId: id, route: 'point', error: errorText(err) });
    return unknown('rate_limit_failed');
  }

  let found: SpeedLimitAlong | null;
  try {
    found = await deps.routes.speedLimitAlong(here, ahead(here, heading, AWS_AHEAD_M));
  } catch (err) {
    log.error('speed-limits aws lookup failed', { requestId: id, route: 'point', error: errorText(err) });
    return unknown('aws_failed');
  }
  if (!found) return unknown('aws_no_limit');

  // The matcher decides, with the route's own road beside the open data, exactly as the device will
  // decide from the tile once the row is stored: a route that snapped to another road, or runs
  // across the car's course, answers nothing.
  const cacheKey = awsCacheKey(found.leg);
  const withAws = matchLimit(heading, [...candidates, await awsCandidate(here, found, cacheKey)]);
  if (withAws.source !== 'cached') return unknown('aws_unmatched');

  try {
    await deps.db.putLimitsCache({
      key: cacheKey,
      leg: found.leg,
      limitMph: found.mph,
      // The geo-routes v2 span says nothing about one-way travel, so the row is stored two-way.
      headingDeg: null,
      ttlDays: cacheTtlDays(deps.random ?? Math.random),
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
