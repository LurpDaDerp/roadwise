import { assert, assertEquals, assertMatch } from '@std/assert';
import { fakeSupabase, type RpcError } from '../_shared/testing/fake_supabase.ts';
import { PointResponseSchema, TileBatchResponseSchema } from '../_shared/speedLimits/wire';
import type { LatLng } from '../_shared/speedLimits/geometry';
import type { RoutesClient, SpanLimit } from './aws.ts';
import {
  acceptsGzip,
  ahead,
  AWS_AHEAD_M,
  AWS_BEHIND_M,
  AWS_COVERAGE,
  AWS_GLOBAL_PER_DAY,
  AWS_GLOBAL_SENTINEL_USER,
  insideCoverage,
  AWS_TTL_MAX_DAYS,
  AWS_TTL_MIN_DAYS,
  awsCacheKey,
  cacheTtlDays,
  createSpeedLimitsDb,
  handleSpeedLimits,
  RATE_LIMITS,
  TILE_CACHE_CONTROL,
  TILE_RPC_TIMEOUT_MS,
  TileTimeout,
  toCandidate,
  type SpeedLimitsDeps,
} from './handler.ts';

const UID = '00000000-0000-4000-8000-000000000001';
const GOOD = 'good-token';

// The fixture's corridor (B1 seed): 9000000001 primary 35 mph along lat 47.6062, digitised east;
// 9000000004 an untagged residential way along lng -122.3200, digitised north.
const CORRIDOR_POINT = { lat: 47.6062, lng: -122.315, heading: 90 };
const UNTAGGED_POINT = { lat: 47.606, lng: -122.3200, heading: 0 };
const TILE_KEYS = ['15/5249/11443', '15/5250/11443', '15/5251/11443'];

type Row = Record<string, unknown>;
type RpcReply = { data?: unknown; error?: RpcError | null };

const corridorRow: Row = {
  provider: 'osm',
  segment_key: '9000000001',
  limit_mph: 35,
  highway: 'primary',
  oneway: 0,
  distance_m: 0.3,
  bearing_deg: 90,
};
const untaggedRow: Row = {
  provider: 'osm',
  segment_key: '9000000004',
  limit_mph: null,
  highway: 'residential',
  oneway: 0,
  distance_m: 2,
  bearing_deg: 0,
};

const segment = (id: string, over: Row = {}): Row => ({
  id,
  provider: 'osm',
  limitMph: 35,
  highway: 'primary',
  oneway: 0,
  line: '_p~iF~ps|U_ulLnnqC',
  ...over,
});

const tileBatch = (keys = TILE_KEYS, over: (i: number) => Row = () => ({})) => ({
  tiles: keys.map((tile, i) => ({
    tile,
    expiresAt: 1_790_000_000_000,
    truncated: false,
    segments: [segment('9000000001'), segment('9000000004', { limitMph: null, highway: 'residential' })],
    ...over(i),
  })),
});

/** The route north along the untagged way, as AWS would snap it. */
const NORTH_LEG: LatLng[] = [
  { lat: 47.606, lng: -122.32 },
  { lat: 47.6067, lng: -122.32 },
  { lat: 47.60735, lng: -122.32 },
];

interface Stub extends RoutesClient {
  calls: { origin: LatLng; dest: LatLng }[];
}

/** A stub AWS client; a test's answer may be one span, a list, or null (no usable span). */
const stubRoutes = (
  answer: (origin: LatLng, dest: LatLng) => Promise<SpanLimit | SpanLimit[] | null>
): Stub => {
  const calls: Stub['calls'] = [];
  return {
    calls,
    async speedLimitsAlong(origin, dest) {
      calls.push({ origin, dest });
      const got = await answer(origin, dest);
      return got === null ? [] : Array.isArray(got) ? got : [got];
    },
  };
};

/** Flat-earth metres between two points, as the matcher measures. */
const metres = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111_320);

/** The route AWS would snap along the untagged way, between the ends the handler asked for. */
const snappedNorth = (origin: LatLng, dest: LatLng): LatLng[] => [
  { lat: origin.lat, lng: -122.32 },
  { lat: (origin.lat + dest.lat) / 2, lng: -122.32 },
  { lat: dest.lat, lng: -122.32 },
];

interface Harness {
  deps: SpeedLimitsDeps;
  rpc: { fn: string; args: Record<string, unknown> }[];
  logs: unknown[][];
  infos: Row[];
}

function harness(opts: {
  candidates?: Row[];
  tiles?: unknown;
  routes?: RoutesClient | null;
  rpc?: Record<string, (args: Record<string, unknown>) => RpcReply>;
  random?: () => number;
} = {}): Harness {
  const fake = fakeSupabase({
    rpc: (fn, args) => {
      if (opts.rpc?.[fn]) return opts.rpc[fn](args);
      switch (fn) {
        case 'speed_limit_candidates':
          return { data: opts.candidates ?? [] };
        case 'speed_limit_tiles':
          return { data: opts.tiles ?? tileBatch() };
        case 'take_rate_limit':
          return { data: true };
        case 'put_limits_cache':
          return { data: '0123456789abcdef' };
        default:
          return { error: { code: 'XX000', message: `unexpected rpc ${fn}` } };
      }
    },
  });
  const logs: unknown[][] = [];
  const infos: Row[] = [];
  const log = {
    info: (...a: unknown[]) => {
      logs.push(a);
      infos.push(a[1] as Row);
    },
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
  };
  const deps: SpeedLimitsDeps = {
    verifyJwt: (t) => Promise.resolve(t === GOOD ? UID : null),
    db: createSpeedLimitsDb(fake.client, log),
    routes: opts.routes ?? null,
    log,
    random: opts.random ?? (() => 0.5),
  };
  return { deps, rpc: fake.rpcCalls, logs, infos };
}

const post = (body: unknown, token: string | null = GOOD) =>
  new Request('http://local/speed-limits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const get = (query: string, token: string | null = GOOD, headers: Record<string, string> = {}) =>
  new Request(`http://local/speed-limits${query}`, {
    method: 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });

const tilesQuery = (keys: string[]) => `?tiles=${keys.join(',')}`;
const fns = (h: Harness) => h.rpc.map((c) => c.fn);

// --- auth and shape ---

Deno.test('no token, or a token Auth refuses, is 401 on both routes and touches nothing', async () => {
  const h = harness({ candidates: [corridorRow] });
  for (const req of [post(CORRIDOR_POINT, null), post(CORRIDOR_POINT, 'bad'), get(tilesQuery(TILE_KEYS), null), get(tilesQuery(TILE_KEYS), 'bad')]) {
    const res = await handleSpeedLimits(req, h.deps);
    assertEquals(res.status, 401);
    assertEquals(await res.json(), { code: 'unauthorized' });
  }
  assertEquals(h.rpc, []);
});

Deno.test('an Auth outage is 503 retry, not 401', async () => {
  const h = harness();
  h.deps.verifyJwt = () => Promise.reject(new Error('fetch failed'));
  const res = await handleSpeedLimits(post(CORRIDOR_POINT), h.deps);
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

Deno.test('any other method is 405 naming GET and POST', async () => {
  const h = harness();
  const res = await handleSpeedLimits(new Request('http://local/speed-limits', { method: 'PUT' }), h.deps);
  assertEquals(res.status, 405);
  assertEquals(res.headers.get('allow'), 'GET, POST');
  await res.body?.cancel();
});

Deno.test('a point request outside the contract is 400 and queries nothing', async () => {
  const h = harness();
  for (const body of [
    { ...CORRIDOR_POINT, lat: 91 },
    { ...CORRIDOR_POINT, heading: 360 },
    { lat: 47.6, lng: -122.3 },
    { ...CORRIDOR_POINT, radiusM: 51 },
    { ...CORRIDOR_POINT, userId: 'someone-else' },
  ]) {
    const res = await handleSpeedLimits(post(body), h.deps);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, 'invalid_payload');
  }
  const bad = await handleSpeedLimits(post('{not json'), h.deps);
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  assertEquals(h.rpc, []);
});

// --- point: open data ---

Deno.test('a matched posted road answers posted with the matcher confidence, and never calls AWS', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({ candidates: [corridorRow], routes });
  const res = await handleSpeedLimits(post(CORRIDOR_POINT), h.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { source: 'posted', limitMph: 35, matchConfidence: 0.95, parallelRoads: false, provider: 'osm' });
  PointResponseSchema.parse(body);
  assertEquals(routes.calls.length, 0);
  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_candidates']);
  assertEquals(h.rpc[0].args, { p_user: UID, p_key: 'speed_point', p_window: '1 hour', p_max: 600 });
  assertEquals(h.rpc[1].args, { p_lat: 47.6062, p_lng: -122.315, p_radius_m: 25 });
});

Deno.test('an untagged way with no AWS configured is unknown with confidence 0, and tiles say fallback null', async () => {
  const h = harness({ candidates: [untaggedRow], routes: null });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: 'unknown', limitMph: null, matchConfidence: 0, parallelRoads: false, provider: null });
  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_candidates']);

  const tiles = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(tiles.status, 200);
  assertEquals((await tiles.json()).fallback, null);
});

// --- point: the AWS fallback ---

Deno.test('an untagged way with AWS answers 45 mph cached at 0.7 and caches the route leg', async () => {
  let leg: LatLng[] = [];
  const routes = stubRoutes((o, d) => {
    leg = snappedNorth(o, d);
    return Promise.resolve({ mph: 45, leg });
  });
  const h = harness({ candidates: [untaggedRow], routes, random: () => 0.99 });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: 'cached', limitMph: 45, matchConfidence: 0.7, parallelRoads: false, provider: 'aws' });

  // one route, from behind the car on the reverse heading to ahead of it on the heading
  assertEquals(routes.calls.length, 1);
  const { origin, dest } = routes.calls[0];
  assert(Math.abs((47.606 - origin.lat) * 111_320 - (75 + 0.99 * 125)) < 0.01);
  assert(Math.abs((dest.lat - 47.606) * 111_320 - (150 + 0.99 * 150)) < 0.01);
  assert(Math.abs(origin.lng - -122.32) < 1e-9 && Math.abs(dest.lng - -122.32) < 1e-9);

  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_candidates', 'take_rate_limit', 'take_rate_limit', 'put_limits_cache']);
  assertEquals(h.rpc[2].args, { p_user: UID, p_key: 'aws_limits', p_window: '1 day', p_max: 100 });
  assertEquals(h.rpc[3].args, { p_user: AWS_GLOBAL_SENTINEL_USER, p_key: 'aws_global', p_window: '1 day', p_max: 2000 });
  assertEquals(h.rpc[4].args, {
    p_key: awsCacheKey(leg),
    p_line: { type: 'LineString', coordinates: leg.map((p) => [p.lng, p.lat]) },
    p_limit_mph: 45,
    p_heading: null,
    p_ttl_days: 10,
  });
});

Deno.test('neither end of the stored line sits at the car, and the ends move from lookup to lookup', async () => {
  const here = { lat: UNTAGGED_POINT.lat, lng: UNTAGGED_POINT.lng };
  const stored: number[][][] = [];
  for (const r of [0, 0.37, 0.999]) {
    const routes = stubRoutes((o, d) => Promise.resolve({ mph: 45, leg: snappedNorth(o, d) }));
    const h = harness({ candidates: [untaggedRow], routes, random: () => r });
    await (await handleSpeedLimits(post(UNTAGGED_POINT), h.deps)).body?.cancel();
    const line = (h.rpc.find((c) => c.fn === 'put_limits_cache')!.args.p_line as { coordinates: number[][] }).coordinates;
    stored.push(line);
    const [first, last] = [line[0], line[line.length - 1]];
    const back = metres(here, { lat: first[1], lng: first[0] });
    const fwd = metres(here, { lat: last[1], lng: last[0] });
    assert(back >= AWS_BEHIND_M.min - 0.01 && back <= AWS_BEHIND_M.max + 0.01, String(back));
    assert(fwd >= AWS_AHEAD_M.min - 0.01 && fwd <= AWS_AHEAD_M.max + 0.01, String(fwd));
  }
  assertEquals(new Set(stored.map((l) => JSON.stringify(l[0]))).size, 3);
});

Deno.test('the matcher picks the span the car is on from the longer route, and only that span is cached', async () => {
  // Three spans along the untagged way: 25 mph behind, 45 mph through the car, 35 mph ahead.
  const at = (m: number): LatLng => ({ lat: 47.606 + m / 111_320, lng: -122.32 });
  const spans: SpanLimit[] = [
    { mph: 25, leg: [at(-150), at(-60)] },
    { mph: 45, leg: [at(-60), at(0.5), at(90)] },
    { mph: 35, leg: [at(90), at(250)] },
  ];
  const routes = stubRoutes(() => Promise.resolve(spans));
  const h = harness({ candidates: [untaggedRow], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals((await res.json()).limitMph, 45);
  const cached = h.rpc.filter((c) => c.fn === 'put_limits_cache');
  assertEquals(cached.length, 1);
  assertEquals(cached[0].args.p_limit_mph, 45);
  assertEquals(cached[0].args.p_key, awsCacheKey(spans[1].leg));
  assertEquals((cached[0].args.p_line as { coordinates: number[][] }).coordinates, spans[1].leg.map((p) => [p.lng, p.lat]));
});

Deno.test('outside every loaded state, AWS is not asked and no budget is spent', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({ candidates: [], routes });
  // Portland, OR: south of Washington's box
  const res = await handleSpeedLimits(post({ lat: 45.4, lng: -122.68, heading: 0 }), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_candidates']);
  assertEquals(h.infos.at(-1)?.outcome, 'outside_coverage');
});

Deno.test('the coverage list is pinned to Washington', () => {
  assertEquals(AWS_COVERAGE, [{ state: 'WA', minLat: 45.5, maxLat: 49.05, minLng: -124.9, maxLng: -116.85 }]);
  assertEquals(
    [
      insideCoverage({ lat: 47.6062, lng: -122.3321 }), // Seattle
      insideCoverage({ lat: 47.6588, lng: -117.426 }), // Spokane
      insideCoverage({ lat: 45.5152, lng: -122.6784 }), // Portland, OR: inside the rounded box (edge)
      insideCoverage({ lat: 37.7749, lng: -122.4194 }), // San Francisco
      insideCoverage({ lat: 49.2827, lng: -123.1207 }), // Vancouver, BC
    ],
    [true, true, true, false, false]
  );
});

Deno.test('a spent global AWS budget is unknown without calling AWS', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({
    candidates: [untaggedRow],
    routes,
    rpc: { take_rate_limit: (args) => ({ data: args.p_key !== 'aws_global' }) },
  });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
  assertEquals(h.infos.at(-1)?.outcome, 'global_rate_limited');
});

Deno.test('the global budget check fails closed: an error there is unknown without calling AWS', async () => {
  // e.g. 23503 while the sentinel owner has no auth.users row
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({
    candidates: [untaggedRow],
    routes,
    rpc: {
      take_rate_limit: (args) =>
        args.p_key === 'aws_global' ? { error: { code: '23503', message: 'fk' } } : { data: true },
    },
  });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
});

Deno.test('a spent point budget is 429 before the candidates query', async () => {
  const h = harness({
    candidates: [corridorRow],
    rpc: { take_rate_limit: (args) => ({ data: args.p_key !== 'speed_point' }) },
  });
  const res = await handleSpeedLimits(post(CORRIDOR_POINT), h.deps);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), '60');
  assertEquals(await res.json(), { code: 'too_many_requests' });
  assertEquals(fns(h), ['take_rate_limit']);
});

Deno.test('with no open-data road at all, an AWS leg under the car answers cached', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 30, leg: NORTH_LEG }));
  const h = harness({ candidates: [], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals((await res.json()).source, 'cached');
  assertEquals(fns(h).at(-1), 'put_limits_cache');
});

Deno.test('an AWS failure is unknown 200, with nothing cached', async () => {
  const routes = stubRoutes(() => Promise.reject(new Error('aws routes answered 500')));
  const h = harness({ candidates: [untaggedRow], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: 'unknown', limitMph: null, matchConfidence: 0, parallelRoads: false, provider: null });
  assert(!fns(h).includes('put_limits_cache'));
  assertEquals(h.infos.at(-1)?.outcome, 'aws_failed');
});

Deno.test('AWS without a limit is unknown, with nothing cached', async () => {
  const routes = stubRoutes(() => Promise.resolve(null));
  const h = harness({ candidates: [untaggedRow], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals((await res.json()).source, 'unknown');
  assert(!fns(h).includes('put_limits_cache'));
});

Deno.test('a spent AWS budget is unknown without calling AWS', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({
    candidates: [untaggedRow],
    routes,
    rpc: { take_rate_limit: (args) => ({ data: args.p_key !== 'aws_limits' }) },
  });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
  // the user's refusal never reaches the global row
  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_candidates', 'take_rate_limit']);
});

Deno.test('a failed budget check is unknown without calling AWS, never a 5xx', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({
    candidates: [untaggedRow],
    routes,
    rpc: { take_rate_limit: (args) => (args.p_key === 'aws_limits' ? { error: { code: '40001', message: 'x' } } : { data: true }) },
  });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
});

Deno.test('an AWS leg that snapped to another road (40 m away) is unknown and not cached', async () => {
  const offset = 40 / (111_320 * Math.cos(47.606 * Math.PI / 180));
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG.map((p) => ({ ...p, lng: p.lng + offset })) }));
  const h = harness({ candidates: [untaggedRow], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals((await res.json()).source, 'unknown');
  assert(!fns(h).includes('put_limits_cache'));
});

Deno.test('an AWS leg across the car course is unknown and not cached', async () => {
  const east: LatLng[] = [{ lat: 47.606, lng: -122.3201 }, { lat: 47.606, lng: -122.318 }];
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: east }));
  const h = harness({ candidates: [untaggedRow], routes });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals((await res.json()).source, 'unknown');
  assert(!fns(h).includes('put_limits_cache'));
});

Deno.test('a failed cache write still answers what AWS said', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({ candidates: [untaggedRow], routes, rpc: { put_limits_cache: () => ({ error: { code: '22023', message: 'line must be…' } }) } });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).limitMph, 45);
});

Deno.test('a candidate lookup failure maps through the shared SQLSTATE mapping', async () => {
  const h = harness({ rpc: { speed_limit_candidates: () => ({ error: { code: '40001', message: 'serialization' } }) } });
  const res = await handleSpeedLimits(post(CORRIDOR_POINT), h.deps);
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

// --- cache identity, TTL, budgets ---

Deno.test('the rate-limit budgets are pinned', () => {
  assertEquals(AWS_GLOBAL_PER_DAY, 2000);
  assertEquals(AWS_GLOBAL_SENTINEL_USER, '00000000-0000-0000-0000-000000000000');
  assertEquals(RATE_LIMITS, {
    aws: { key: 'aws_limits', window: '1 day', max: 100 },
    awsGlobal: { key: 'aws_global', window: '1 day', max: 2000 },
    tiles: { key: 'speed_tiles', window: '1 hour', max: 240, retryAfterS: 600 },
    point: { key: 'speed_point', window: '1 hour', max: 600, retryAfterS: 60 },
  });
  assertEquals([AWS_BEHIND_M, AWS_AHEAD_M], [{ min: 75, max: 200 }, { min: 150, max: 300 }]);
});

Deno.test('the cache TTL is a whole number of days, uniform over 7..10', () => {
  assertEquals([AWS_TTL_MIN_DAYS, AWS_TTL_MAX_DAYS], [7, 10]);
  assertEquals([0, 0.2499, 0.25, 0.5, 0.75, 0.999999].map((r) => cacheTtlDays(() => r)), [7, 7, 8, 9, 10, 10]);
  assertEquals(cacheTtlDays(() => 1), 10);
});

Deno.test('the cache key comes from the snapped leg, never the query origin', () => {
  // Two roads near one origin (an overpass) snap to different legs and so to different keys.
  const over = NORTH_LEG;
  const under: LatLng[] = [{ lat: 47.606, lng: -122.3203 }, { lat: 47.606, lng: -122.3185 }];
  assert(awsCacheKey(over) !== awsCacheKey(under));
  assert(awsCacheKey(over).length <= 128);
  assertEquals(awsCacheKey(over), 'aws:3:47.60600,-122.32000;47.60735,-122.32000');
});

Deno.test('ahead() moves the given metres along the compass bearing', () => {
  const p = { lat: 47.6, lng: -122.3 };
  const east = ahead(p, 90, 150);
  assert(Math.abs(east.lat - p.lat) < 1e-12);
  assert(Math.abs((east.lng - p.lng) * 111_320 * Math.cos(47.6 * Math.PI / 180) - 150) < 1e-6);
});

Deno.test('candidate rows are narrowed: null limits kept, the device key built, drift dropped', () => {
  assertEquals(toCandidate(untaggedRow), {
    provider: 'osm',
    key: 'osm:9000000004',
    limitMph: null,
    highway: 'residential',
    oneway: 0,
    distanceM: 2,
    bearingDeg: 0,
  });
  assertEquals(toCandidate({ ...corridorRow, provider: 'aws', segment_key: '0123456789abcdef', oneway: 1 })?.key, 'aws:0123456789abcdef');
  assert(Number.isNaN(toCandidate({ ...corridorRow, bearing_deg: null })!.bearingDeg));
  assertEquals(toCandidate({ ...corridorRow, provider: 'here' }), null);
  assertEquals(toCandidate({ ...corridorRow, oneway: 2 }), null);
  assertEquals(toCandidate({ ...corridorRow, distance_m: null }), null);
});

// --- tiles ---

Deno.test('a tile batch answers B1 JSON plus fallback aws, validated, cacheable, in the order asked', async () => {
  const routes = stubRoutes(() => Promise.resolve(null));
  const h = harness({ routes, tiles: tileBatch(TILE_KEYS, (i) => (i === 1 ? { truncated: true } : {})) });
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('cache-control'), TILE_CACHE_CONTROL);
  assertEquals(TILE_CACHE_CONTROL, 'private, max-age=86400');
  const body = await res.json();
  TileBatchResponseSchema.parse(body);
  assertEquals(body.fallback, 'aws');
  assertEquals(body.tiles.map((t: Row) => t.tile), TILE_KEYS);
  // the database's truncated flag passes through unchanged
  assertEquals(body.tiles.map((t: Row) => t.truncated), [false, true, false]);
  assertEquals(fns(h), ['take_rate_limit', 'speed_limit_tiles']);
  assertEquals(h.rpc[0].args, { p_user: UID, p_key: 'speed_tiles', p_window: '1 hour', p_max: 240 });
  assertEquals(h.rpc[1].args, { p_keys: TILE_KEYS });
});

Deno.test('five tile keys, a bad key, a duplicate or none are 400 before any database call', async () => {
  const h = harness();
  for (const q of [
    tilesQuery([...TILE_KEYS, '15/5249/11444', '15/5250/11444']),
    tilesQuery(['15/5249/11443', '14/1/1']),
    tilesQuery(['15/5249/11443', '15/5249/11443']),
    tilesQuery(['15/32768/1']),
    '',
    '?tiles=',
  ]) {
    const res = await handleSpeedLimits(get(q), h.deps);
    assertEquals(res.status, 400, q);
    assertEquals((await res.json()).code, 'invalid_payload');
  }
  assertEquals(h.rpc, []);
});

Deno.test('a spent tile budget is 429 without the tile query', async () => {
  const h = harness({ rpc: { take_rate_limit: (args) => ({ data: args.p_key !== 'speed_tiles' }) } });
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get('retry-after'), '600');
  await res.body?.cancel();
  assertEquals(fns(h), ['take_rate_limit']);
});

Deno.test('a batch with an HPMS segment lacking a limit is refused whole: 500, nothing sent', async () => {
  const bad = tileBatch(TILE_KEYS, (i) => (i === 2 ? { segments: [segment('9000000101', { provider: 'hpms', limitMph: null })] } : {}));
  const h = harness({ tiles: bad });
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { code: 'invalid_tiles' });
});

Deno.test('a batch that does not answer the keys asked, in order, is refused', async () => {
  const h = harness({ tiles: tileBatch([TILE_KEYS[1], TILE_KEYS[0], TILE_KEYS[2]]) });
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 500);
  await res.body?.cancel();
});

Deno.test('a batch with a key the contract does not know is refused (strict)', async () => {
  const h = harness({ tiles: { ...tileBatch(), fallback: 'aws', extra: 1 } });
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 500);
  await res.body?.cancel();
});

Deno.test('tiles are gzip-encoded when the request accepts gzip, plain otherwise', async () => {
  const h = harness();
  const gz = await handleSpeedLimits(get(tilesQuery(TILE_KEYS), GOOD, { 'accept-encoding': 'br, gzip;q=0.8' }), h.deps);
  assertEquals(gz.headers.get('content-encoding'), 'gzip');
  assertEquals(gz.headers.get('vary'), 'Accept-Encoding');
  const text = await new Response(gz.body!.pipeThrough(new DecompressionStream('gzip'))).text();
  TileBatchResponseSchema.parse(JSON.parse(text));

  const plain = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(plain.headers.get('content-encoding'), null);
  TileBatchResponseSchema.parse(await plain.json());
});

Deno.test('Accept-Encoding: gzip;q=0 is honoured', () => {
  const r = (v: string) => new Request('http://local/', { headers: { 'accept-encoding': v } });
  assertEquals([acceptsGzip(r('gzip')), acceptsGzip(r('gzip;q=0')), acceptsGzip(r('identity')), acceptsGzip(r('*'))], [true, false, false, true]);
});

Deno.test('a tile call that outlives its timeout is 503 retry', async () => {
  assertEquals(TILE_RPC_TIMEOUT_MS <= 5_000, true);
  const h = harness();
  h.deps.db.tiles = () => Promise.reject(new TileTimeout());
  const res = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

// --- logs ---

Deno.test('logs carry requestId, route, outcome and source only: no coordinate, heading or tile key', async () => {
  const routes = stubRoutes(() => Promise.reject(new Error('aws routes answered 500')));
  const h = harness({ candidates: [untaggedRow], routes });
  const point = { lat: 47.61234, lng: -122.33456, heading: 17.25 };
  for (const req of [
    post(point),
    post({ ...point, lat: 123.456 }),
    get(tilesQuery(TILE_KEYS)),
    get(tilesQuery(['15/5249/11443', '15/5249/11443'])),
  ]) {
    const res = await handleSpeedLimits(req, h.deps);
    await res.body?.cancel();
  }
  const text = JSON.stringify(h.logs);
  for (const needle of ['47.61', '122.33', '17.25', '123.45', '5249', '11443', '5250', '5251']) {
    assert(!text.includes(needle), `log leaked ${needle}: ${text}`);
  }
  assertEquals(h.infos.length, 4);
  for (const line of h.infos) {
    assertEquals(Object.keys(line).sort(), ['outcome', 'requestId', 'route', 'source']);
    assertMatch(String(line.requestId), /^[0-9a-f-]{36}$/);
  }
  assertEquals(h.infos.map((l) => [l.route, l.outcome, l.source]), [
    ['point', 'aws_failed', 'unknown'],
    ['point', 'invalid', null],
    ['tiles', 'served', null],
    ['tiles', 'invalid', null],
  ]);
});
