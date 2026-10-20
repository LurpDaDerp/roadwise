// The handler's side of the road-layer fill (fill.ts): what a tile batch and a point request hand
// to `ensure`, and how a filling cell shows in the batch. The fill itself is tested in fill.test.ts.
import { assert, assertEquals } from '@std/assert';
import { fakeSupabase } from '../_shared/testing/fake_supabase.ts';
import type { BBox } from '../_shared/speedLimits/geometry';
import { parseTileKey, tileBounds } from '../_shared/speedLimits/tiles';
import { TileBatchResponseSchema } from '../_shared/speedLimits/wire';
import type { OsmFill } from './fill.ts';
import { createSpeedLimitsDb, FILLING_EXPIRY_MS, handleSpeedLimits, type SpeedLimitsDeps } from './handler.ts';

const UID = '00000000-0000-4000-8000-000000000001';
const NOW = 1_790_000_000_000 - 30 * 86_400_000;
const GOOD = 'good-token';
const KEYS = ['15/5249/11443', '15/5250/11443', '15/5251/11443'];
type Row = Record<string, unknown>;

const segment = (id: string, over: Row = {}): Row => ({ id, provider: 'osm', limitMph: 35, highway: 'primary', oneway: 0, line: '_p~iF~ps|U_ulLnnqC', ...over });
const tileBatch = (keys: string[]) => ({
  tiles: keys.map((tile) => ({ tile, expiresAt: 1_790_000_000_000, truncated: false, segments: [segment('9000000001')] })),
});

interface Harness {
  deps: SpeedLimitsDeps;
  ensured: BBox[][];
  users: string[];
  infos: Row[];
}

function harness(answer: (boxes: readonly BBox[]) => boolean[], withFill = true): Harness {
  const fake = fakeSupabase({
    rpc: (fn) => {
      switch (fn) {
        case 'speed_limit_candidates':
          return { data: [] };
        case 'speed_limit_tiles':
          return { data: tileBatch(KEYS) };
        case 'take_rate_limit':
          return { data: true };
        default:
          return { error: { code: 'XX000', message: `unexpected rpc ${fn}` } };
      }
    },
  });
  const ensured: BBox[][] = [];
  const users: string[] = [];
  const infos: Row[] = [];
  const fill: OsmFill = {
    ensure: (boxes, userId) => {
      ensured.push([...boxes]);
      users.push(userId);
      return Promise.resolve(answer(boxes));
    },
    settled: () => Promise.resolve(),
  };
  const log = { info: (...a: unknown[]) => infos.push(a[1] as Row), warn: () => undefined, error: () => undefined };
  const deps: SpeedLimitsDeps = {
    verifyJwt: (t) => Promise.resolve(t === GOOD ? UID : null),
    db: createSpeedLimitsDb(fake.client, log),
    routes: null,
    fill: withFill ? fill : null,
    log,
    now: () => NOW,
  };
  return { deps, ensured, users, infos };
}

const get = (keys: string[]) =>
  new Request(`http://local/speed-limits?tiles=${keys.join(',')}`, { method: 'GET', headers: { authorization: `Bearer ${GOOD}` } });
const post = (body: unknown) =>
  new Request('http://local/speed-limits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GOOD}` },
    body: JSON.stringify(body),
  });

Deno.test('a tile batch hands every requested tile box to the fill, and a tile whose cell is filling is flagged with an expiry FILLING_EXPIRY_MS away', async () => {
  assertEquals(FILLING_EXPIRY_MS, 25_000);
  const h = harness((boxes) => boxes.map((_, i) => i === 1));
  const res = await handleSpeedLimits(get(KEYS), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.ensured, [KEYS.map((k) => tileBounds(parseTileKey(k)!))]);
  assertEquals(h.users, [UID], 'the claims are charged to the token holder');
  const body = await res.json();
  const checked = TileBatchResponseSchema.parse(body);
  assertEquals(checked.tiles.map((t) => t.filling), [undefined, true, undefined]);
  assertEquals(checked.tiles.map((t) => t.expiresAt), [1_790_000_000_000, NOW + FILLING_EXPIRY_MS, 1_790_000_000_000]);
  assertEquals(checked.tiles[1].segments.length, 1, 'the rows already there are sent as they stand');
  assert(!('filling' in body.tiles[0]), 'a loaded tile carries no flag');
  assertEquals(res.headers.get('cache-control'), 'private, max-age=25');
  assertEquals(h.infos.at(-1)?.outcome, 'served_filling');
});

Deno.test('every cell loaded: no flag, the tiles own expiry, outcome served', async () => {
  const h = harness((boxes) => boxes.map(() => false));
  const res = await handleSpeedLimits(get(KEYS), h.deps);
  const body = await res.json();
  assert(body.tiles.every((t: Row) => !('filling' in t)));
  assertEquals(res.headers.get('cache-control'), 'private, max-age=86400');
  assertEquals(h.infos.at(-1)?.outcome, 'served');
});

Deno.test('a filling expiry never pushes a tile later than its own expiry', async () => {
  const h = harness((boxes) => boxes.map(() => true));
  h.deps.now = () => 1_790_000_000_000 - 1_000;
  const res = await handleSpeedLimits(get(KEYS), h.deps);
  const body = await res.json();
  assertEquals(body.tiles[0].expiresAt, 1_790_000_000_000);
  assertEquals(res.headers.get('cache-control'), 'private, max-age=1');
});

Deno.test('a point request claims the box of the point itself (one cell, plus its look-ahead) and answers as before', async () => {
  const h = harness((boxes) => boxes.map(() => true));
  const res = await handleSpeedLimits(post({ lat: 47.6062, lng: -122.315, heading: 90 }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.ensured, [[{ minLat: 47.6062, maxLat: 47.6062, minLng: -122.315, maxLng: -122.315 }]]);
  assertEquals(h.users, [UID]);
  assertEquals((await res.json()).source, 'unknown');
});

Deno.test('without the fill configured nothing is claimed and no tile is flagged', async () => {
  const h = harness(() => {
    throw new Error('must not be called');
  }, false);
  const res = await handleSpeedLimits(get(KEYS), h.deps);
  const body = await res.json();
  assertEquals(h.ensured, []);
  assert(body.tiles.every((t: Row) => !('filling' in t)));
  assertEquals(h.infos.at(-1)?.outcome, 'served');
});

Deno.test('a refused request (bad keys, no token) never reaches the fill', async () => {
  const h = harness((boxes) => boxes.map(() => true));
  for (const req of [
    new Request('http://local/speed-limits?tiles=15/1/1,15/1/1', { headers: { authorization: `Bearer ${GOOD}` } }),
    new Request(`http://local/speed-limits?tiles=${KEYS[0]}`),
  ]) {
    const res = await handleSpeedLimits(req, h.deps);
    assert(res.status === 400 || res.status === 401);
    await res.body?.cancel();
  }
  assertEquals(h.ensured, []);
});
