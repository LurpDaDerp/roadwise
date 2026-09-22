import { assert, assertEquals, assertMatch } from '@std/assert';
import { fakeSupabase, type RpcError } from '../_shared/testing/fake_supabase.ts';
import { PointResponseSchema, TileBatchResponseSchema } from '../_shared/speedLimits/wire';
import type { LatLng } from '../_shared/speedLimits/geometry';
import type { RoutesClient, SpeedLimitAlong } from './aws.ts';
import {
  acceptsGzip,
  ahead,
  AWS_AHEAD_M,
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

const stubRoutes = (answer: () => Promise<SpeedLimitAlong | null>): Stub => {
  const calls: Stub['calls'] = [];
  return {
    calls,
    speedLimitAlong(origin, dest) {
      calls.push({ origin, dest });
      return answer();
    },
  };
};

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
  assertEquals(fns(h), ['speed_limit_candidates']);
  assertEquals(h.rpc[0].args, { p_lat: 47.6062, p_lng: -122.315, p_radius_m: 25 });
});

Deno.test('an untagged way with no AWS configured is unknown with confidence 0, and tiles say fallback null', async () => {
  const h = harness({ candidates: [untaggedRow], routes: null });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: 'unknown', limitMph: null, matchConfidence: 0, parallelRoads: false, provider: null });
  assertEquals(fns(h), ['speed_limit_candidates']);

  const tiles = await handleSpeedLimits(get(tilesQuery(TILE_KEYS)), h.deps);
  assertEquals(tiles.status, 200);
  assertEquals((await tiles.json()).fallback, null);
});

// --- point: the AWS fallback ---

Deno.test('an untagged way with AWS answers 45 mph cached at 0.7 and caches the route leg', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({ candidates: [untaggedRow], routes, random: () => 0.99 });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: 'cached', limitMph: 45, matchConfidence: 0.7, parallelRoads: false, provider: 'aws' });

  // one route from the point to 150 m ahead on the heading
  assertEquals(routes.calls.length, 1);
  assertEquals(routes.calls[0].origin, { lat: 47.606, lng: -122.32 });
  const dest = routes.calls[0].dest;
  assert(Math.abs((dest.lat - 47.606) * 111_320 - AWS_AHEAD_M) < 0.01);
  assert(Math.abs(dest.lng - -122.32) < 1e-9);

  assertEquals(fns(h), ['speed_limit_candidates', 'take_rate_limit', 'put_limits_cache']);
  assertEquals(h.rpc[1].args, { p_user: UID, p_key: 'aws_limits', p_window: '1 day', p_max: 100 });
  assertEquals(h.rpc[2].args, {
    p_key: 'aws:3:47.60600,-122.32000;47.60735,-122.32000',
    p_line: { type: 'LineString', coordinates: [[-122.32, 47.606], [-122.32, 47.6067], [-122.32, 47.60735]] },
    p_limit_mph: 45,
    p_heading: null,
    p_ttl_days: 10,
  });
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
  const h = harness({ candidates: [untaggedRow], routes, rpc: { take_rate_limit: () => ({ data: false }) } });
  const res = await handleSpeedLimits(post(UNTAGGED_POINT), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, 'unknown');
  assertEquals(routes.calls.length, 0);
  assertEquals(fns(h), ['speed_limit_candidates', 'take_rate_limit']);
});

Deno.test('a failed budget check is unknown without calling AWS, never a 5xx', async () => {
  const routes = stubRoutes(() => Promise.resolve({ mph: 45, leg: NORTH_LEG }));
  const h = harness({ candidates: [untaggedRow], routes, rpc: { take_rate_limit: () => ({ error: { code: '40001', message: 'x' } }) } });
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
  assertEquals(RATE_LIMITS, {
    aws: { key: 'aws_limits', window: '1 day', max: 100 },
    tiles: { key: 'speed_tiles', window: '1 hour', max: 240, retryAfterS: 600 },
  });
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
  const h = harness({ rpc: { take_rate_limit: () => ({ data: false }) } });
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
