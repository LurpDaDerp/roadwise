import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { fillCellKey, parseTileKey, tileBounds } from '../_shared/speedLimits/tiles';
import {
  CELL_DEG,
  cellBounds,
  cellKey,
  cellOf,
  cellsCovering,
  CLAIM_BUDGET,
  createOsmFill,
  DONE_MEMO_MS,
  expand,
  fillable,
  FILLING_MEMO_MS,
  LOOKAHEAD_M,
  lookaheadCells,
  MAX_CLAIMS_PER_REQUEST,
  MAX_LAT,
  MAX_LOOKAHEAD_CELLS,
  OVERPASS_BUDGET,
  OVERPASS_DE_MIB,
  OVERPASS_DE_QUERIES,
  OVERPASS_DE_START,
  REFUSED_COOLDOWN_MS,
  type Cell,
  type ClaimStatus,
  type FillOutcome,
  type OsmFillDb,
  UPSERT_BATCH,
} from './fill.ts';
import { OVERPASS_DE, OVERPASS_ENDPOINTS, overpassQuery, PRIVATE_COFFEE, type WayRow } from './overpass.ts';

const T0 = 1_760_000_000_000;
const UID = '00000000-0000-4000-8000-000000000001';
/** The fixture corridor's tile (0002's seed): one cell, 670 m north of its south edge. */
const TILE = tileBounds(parseTileKey('15/5249/11443')!);
const SEATTLE: Cell = { y: 476, x: -1224 };
const SOUTH: Cell = { y: 475, x: -1224 };

// --- cell maths ---

Deno.test('cellOf: floor of lat/0.1 and lng/0.1, exact on a boundary, right for negatives, clamped at the grid', () => {
  assertEquals(CELL_DEG, 0.1);
  assertEquals(cellOf(47.6062, -122.3321), SEATTLE);
  assertEquals(cellOf(47.6, -122.4), SEATTLE);
  assertEquals(cellOf(47.69999999, -122.30000001), SEATTLE);
  assertEquals(cellOf(47.7, -122.3), { y: 477, x: -1223 });
  assertEquals(cellOf(-0.05, -0.05), { y: -1, x: -1 });
  assertEquals(cellOf(0, 0), { y: 0, x: 0 });
  assertEquals(cellOf(90, 180), { y: 899, x: 1799 });
  assertEquals(cellOf(-90, -180), { y: -900, x: -1800 });
  assertEquals(cellKey(SEATTLE), '476/-1224');
});

Deno.test('cellBounds is the 0.1 degree square, and cellOf of each corner (but the far ones) is the cell', () => {
  const b = cellBounds(SEATTLE);
  assertAlmostEquals(b.minLat, 47.6, 1e-9);
  assertAlmostEquals(b.maxLat, 47.7, 1e-9);
  assertAlmostEquals(b.minLng, -122.4, 1e-9);
  assertAlmostEquals(b.maxLng, -122.3, 1e-9);
  assertEquals(cellOf(b.minLat, b.minLng), SEATTLE);
  assertEquals(cellOf(b.minLat + 0.05, b.minLng + 0.05), SEATTLE);
  for (const c of [{ y: 0, x: 0 }, { y: -1, x: -1 }, { y: 899, x: 1799 }, { y: -900, x: -1800 }]) {
    const bb = cellBounds(c);
    assertEquals(cellOf(bb.minLat + 0.001, bb.minLng + 0.001), c);
  }
});

Deno.test('cellsCovering: one cell for a tile inside it, two across an edge, four across a corner, one for a point', () => {
  assertEquals(cellsCovering(TILE), [SEATTLE]);
  assertEquals(cellsCovering({ minLat: 47.65, maxLat: 47.66, minLng: -122.405, maxLng: -122.395 }), [{ y: 476, x: -1225 }, SEATTLE]);
  assertEquals(cellsCovering({ minLat: 47.595, maxLat: 47.605, minLng: -122.405, maxLng: -122.395 }), [
    { y: 475, x: -1225 },
    SOUTH,
    { y: 476, x: -1225 },
    SEATTLE,
  ]);
  assertEquals(cellsCovering({ minLat: 47.6062, maxLat: 47.6062, minLng: -122.3321, maxLng: -122.3321 }), [SEATTLE]);
});

Deno.test('expand grows a box by metres on every side, longitude scaled at its poleward edge, clamped to the globe', () => {
  const e = expand(TILE, 1500);
  assertAlmostEquals(e.minLat, TILE.minLat - 1500 / 111_320, 1e-9);
  assertAlmostEquals(e.maxLat, TILE.maxLat + 1500 / 111_320, 1e-9);
  const dLng = 1500 / (111_320 * Math.cos((TILE.maxLat * Math.PI) / 180));
  assertAlmostEquals(e.minLng, TILE.minLng - dLng, 1e-9);
  assertAlmostEquals(e.maxLng, TILE.maxLng + dLng, 1e-9);
  const pole = expand({ minLat: 89.99, maxLat: 90, minLng: 179.99, maxLng: 180 }, 1500);
  assertEquals([pole.maxLat, pole.maxLng], [90, 180]);
});

Deno.test('lookaheadCells: the cells within 1.5 km of the box that it does not overlap', () => {
  assertEquals(LOOKAHEAD_M, 1500);
  // 670 m north of the cell's south edge, 5 km from its west edge, 1.64 km from its east edge
  assertEquals(lookaheadCells(TILE), [SOUTH]);
  // the next tile east is within 1.5 km of the east edge too
  assertEquals(lookaheadCells(tileBounds(parseTileKey('15/5250/11443')!)), [SOUTH, { y: 475, x: -1223 }, { y: 476, x: -1223 }]);
  // a point near the south-west corner: the three cells over the corner
  assertEquals(lookaheadCells({ minLat: 47.601, maxLat: 47.601, minLng: -122.399, maxLng: -122.399 }), [{ y: 475, x: -1225 }, SOUTH, { y: 476, x: -1225 }]);
  // the middle of a cell: nothing within 1.5 km
  assertEquals(lookaheadCells({ minLat: 47.65, maxLat: 47.65, minLng: -122.35, maxLng: -122.35 }), []);
});

// --- the fill ---

interface Harness {
  db: OsmFillDb;
  claims: Cell[];
  finishes: { cell: Cell; outcome: FillOutcome; ways: number }[];
  batches: WayRow[][];
  budgets: number;
  /** The app-wide budget keys taken, in order. */
  globalKeys: string[];
  userBudgets: { userId: string; key: string; window: string; max: number }[];
  background: Promise<void>[];
  fetches: { url: string; body: string }[];
  logs: { level: string; args: unknown[] }[];
  clock: { now: number };
}

const wayJson = (id: number) =>
  `{"type":"way","id":${id},"nodes":[1,2],"geometry":[{"lat":47.61,"lon":-122.31},{"lat":47.611,"lon":-122.309}],"tags":{"highway":"residential","maxspeed":"25 mph"}}`;
const replyOf = (ids: number[], extra = '') => `{"version":0.6,"generator":"test","elements":[${ids.map(wayJson).join(',')}]${extra}}`;
const body = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

function harness(opts: {
  claim?: (cell: Cell) => ClaimStatus;
  budget?: boolean;
  /** Per key, overriding `budget`. */
  global?: (key: string) => boolean;
  userBudget?: boolean;
  answers?: ((url: string) => Response | Promise<Response>)[];
} = {}) {
  const h: Harness = {
    claims: [],
    finishes: [],
    batches: [],
    budgets: 0,
    globalKeys: [],
    userBudgets: [],
    background: [],
    fetches: [],
    logs: [],
    clock: { now: T0 },
    db: {
      claimFillCell: (cell) => {
        h.claims.push(cell);
        return Promise.resolve(opts.claim ? opts.claim(cell) : 'claimed');
      },
      finishFillCell: (cell, outcome, ways) => {
        h.finishes.push({ cell, outcome, ways });
        return Promise.resolve(true);
      },
      takeRateLimit: (userId, key, window, max) => {
        h.userBudgets.push({ userId, key, window, max });
        return Promise.resolve(opts.userBudget ?? true);
      },
      upsertWays: (ways) => {
        h.batches.push([...ways]);
        return Promise.resolve(ways.length);
      },
      takeGlobalRateLimit: (key) => {
        h.budgets += 1;
        h.globalKeys.push(key);
        return Promise.resolve(opts.global ? opts.global(key) : (opts.budget ?? true));
      },
    },
  };
  const answers = opts.answers ?? [() => new Response(body(replyOf([1, 2, 3])), { status: 200 })];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    h.fetches.push({ url, body: String(init.body) });
    const a = answers[Math.min(h.fetches.length - 1, answers.length - 1)];
    return await a(url);
  };
  const log = {
    info: (...args: unknown[]) => h.logs.push({ level: 'info', args }),
    warn: (...args: unknown[]) => h.logs.push({ level: 'warn', args }),
    error: (...args: unknown[]) => h.logs.push({ level: 'error', args }),
  };
  const fill = createOsmFill({ db: h.db, background: (p) => h.background.push(p), log, fetch, now: () => h.clock.now });
  return Object.assign(h, { fill });
}

Deno.test('a tile in an unloaded cell: the cell and its look-ahead are claimed (own first), the tile reads filling, and the fill runs in the background', async () => {
  const h = harness();
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.claims, [SEATTLE, SOUTH]);
  assertEquals(h.background.length, 2);
  await h.fill.settled();
  // one Overpass query per claimed cell, with the cell's own bbox, in claim order
  assertEquals(h.fetches.map((f) => f.url), [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[0]]);
  assertEquals(h.fetches[0].body, new URLSearchParams({ data: overpassQuery(cellBounds(SEATTLE)) }).toString());
  assertEquals(h.fetches[1].body, new URLSearchParams({ data: overpassQuery(cellBounds(SOUTH)) }).toString());
  assertEquals(h.budgets, 2);
  assertEquals(h.batches.length, 2);
  assertEquals(h.batches[0].map((w) => w.id), [1, 2, 3]);
  assertEquals(h.finishes, [
    { cell: SEATTLE, outcome: 'done', ways: 3 },
    { cell: SOUTH, outcome: 'done', ways: 3 },
  ]);
  // each won claim was charged to the requesting user, before any fetch
  assertEquals(h.userBudgets, [
    { userId: UID, key: 'overpass_claim', window: '1 hour', max: 40 },
    { userId: UID, key: 'overpass_claim', window: '1 hour', max: 40 },
  ]);
  // filled: the next request sees it done from the memo, with no claim
  assertEquals(await h.fill.ensure([TILE], UID), [false]);
  assertEquals(h.claims.length, 2);
  const info = h.logs.filter((l) => l.level === 'info').map((l) => l.args[1] as Record<string, unknown>);
  assertEquals(info.map((i) => [i.outcome, i.ways]), [['filled', 3], ['filled', 3]]);
  assert(info.every((i) => Object.keys(i).sort().join() === 'ms,outcome,ways'), 'the log names outcome, count and time only');
});

Deno.test('the fill upserts in batches of UPSERT_BATCH and reports the rows written', async () => {
  assertEquals(UPSERT_BATCH, 500);
  const ids = Array.from({ length: 1234 }, (_, i) => i + 1);
  const h = harness({ claim: (c) => (c.y === SEATTLE.y && c.x === SEATTLE.x ? 'claimed' : 'done'), answers: [() => new Response(body(replyOf(ids)), { status: 200 })] });
  await h.fill.ensure([TILE], UID);
  await h.fill.settled();
  assertEquals(h.batches.map((b) => b.length), [500, 500, 234]);
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'done', ways: 1234 }]);
});

Deno.test('a done cell is not claimed again for DONE_MEMO_MS; a filling one not for FILLING_MEMO_MS; then they are', async () => {
  assertEquals(DONE_MEMO_MS, 600_000);
  assertEquals(FILLING_MEMO_MS, 15_000);
  const h = harness({ claim: (c) => (c.y === SOUTH.y ? 'filling' : 'done') });
  assertEquals(await h.fill.ensure([TILE], UID), [false]);
  assertEquals(h.claims.length, 2);
  assertEquals(h.background.length, 0);
  await h.fill.ensure([TILE], UID);
  assertEquals(h.claims.length, 2, 'both answers are remembered');
  h.clock.now += FILLING_MEMO_MS;
  await h.fill.ensure([TILE], UID);
  assertEquals(h.claims, [SEATTLE, SOUTH, SOUTH], 'the filling cell is asked about again');
  h.clock.now += DONE_MEMO_MS;
  await h.fill.ensure([TILE], UID);
  assertEquals(h.claims.length, 5, 'and the done one once its memo lapses');
});

Deno.test('a tile whose own cell another caller is filling reads filling; its look-ahead still claims', async () => {
  const h = harness({ claim: (c) => (c.y === SEATTLE.y ? 'filling' : 'claimed') });
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.background.length, 1);
  await h.fill.settled();
  assertEquals(h.finishes, [{ cell: SOUTH, outcome: 'done', ways: 3 }]);
});

Deno.test('a tile across a cell edge is filling until both its cells are done; several tiles share one claim per cell', async () => {
  const h = harness({ claim: (c) => (c.x === -1225 ? 'done' : 'filling') });
  const straddling = { minLat: 47.65, maxLat: 47.66, minLng: -122.405, maxLng: -122.395 };
  const inside = { minLat: 47.65, maxLat: 47.66, minLng: -122.42, maxLng: -122.41 };
  assertEquals(await h.fill.ensure([straddling, inside, TILE], UID), [true, false, true]);
  // own cells of every box first, then the look-ahead cells, each once
  assertEquals(h.claims.map(cellKey), ['476/-1225', '476/-1224', '475/-1224']);
});

Deno.test('a spent app-wide Overpass budget releases the cell (claimable again at once) without fetching; this isolate remembers it as filling for a while', async () => {
  assertEquals(OVERPASS_BUDGET, { key: 'overpass_fill', window: '1 minute', max: 4 });
  const h = harness({ budget: false, claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done') });
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  await h.fill.settled();
  assertEquals(h.fetches.length, 0);
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'released', ways: 0 }]);
  assertEquals((h.logs.at(-1)?.args[1] as Record<string, unknown>).outcome, 'budget_spent');
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.claims.length, 2, 'no second claim within FILLING_MEMO_MS');
});

Deno.test('both mirrors down: the cell is marked failed with nothing written; a 429 on the first mirror falls through to the second', async () => {
  const down = harness({
    claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done'),
    answers: [() => Promise.reject(new TypeError('fetch failed')), () => new Response('', { status: 504 })],
  });
  await down.fill.ensure([TILE], UID);
  await down.fill.settled();
  assertEquals(down.fetches.map((f) => f.url), [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[1]]);
  assertEquals(down.batches, []);
  assertEquals(down.finishes, [{ cell: SEATTLE, outcome: 'failed', ways: 0 }]);
  assertEquals(down.logs.filter((l) => l.level === 'error').length, 1);

  const busy = harness({
    claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done'),
    answers: [() => new Response('busy', { status: 429 }), () => new Response(body(replyOf([9])), { status: 200 })],
  });
  await busy.fill.ensure([TILE], UID);
  await busy.fill.settled();
  assertEquals(busy.fetches.map((f) => f.url), [OVERPASS_ENDPOINTS[0], OVERPASS_ENDPOINTS[1]]);
  assertEquals(busy.finishes, [{ cell: SEATTLE, outcome: 'done', ways: 1 }]);
});

Deno.test('a partial reply (an Overpass remark) keeps the rows it did send but marks the cell failed, so it is fetched again later', async () => {
  const h = harness({
    claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done'),
    answers: [() => new Response(body(replyOf([1, 2], ',"remark":"runtime error: Query timed out"')), { status: 200 })],
  });
  await h.fill.ensure([TILE], UID);
  await h.fill.settled();
  assertEquals(h.batches.map((b) => b.map((w) => w.id)), [[1, 2]]);
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'failed', ways: 2 }]);
  const err = h.logs.find((l) => l.level === 'error')?.args[1] as Record<string, unknown>;
  assertEquals(err.ways, 2);
  assert(String(err.error).includes('OverpassRemark'));
  assertEquals(await h.fill.ensure([TILE], UID), [true], 'not remembered as done');
});

Deno.test('a failing claim RPC reads as filling, is logged without the cell, and starts no fill', async () => {
  const h = harness();
  h.db.claimFillCell = () => Promise.reject(new Error('connection refused'));
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.background.length, 0);
  const err = h.logs.find((l) => l.level === 'error');
  assertEquals(err?.args[0], 'speed-limits osm fill claim failed');
  assert(!JSON.stringify(err?.args).includes('476'), 'no cell in the log');
});

Deno.test('fills run one at a time in an isolate: the second cell is not fetched until the first has finished', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    answers: [
      async () => {
        await gate;
        return new Response(body(replyOf([1])), { status: 200 });
      },
      () => new Response(body(replyOf([2])), { status: 200 }),
    ],
  });
  await h.fill.ensure([TILE], UID);
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(h.fetches.length, 1, 'the second cell waits');
  release();
  await h.fill.settled();
  assertEquals(h.fetches.length, 2);
  assertEquals(h.finishes.map((f) => [cellKey(f.cell), f.outcome]), [['476/-1224', 'done'], ['475/-1224', 'done']]);
});

// --- what one request may start (security review) ---

Deno.test("a user whose claim budget is spent: the claim is released at once, nothing is fetched, and the tile reads filling; the user's budget is checked only for a won claim", async () => {
  assertEquals(CLAIM_BUDGET, { key: 'overpass_claim', window: '1 hour', max: 40 });
  const h = harness({ userBudget: false, claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done') });
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.userBudgets.length, 1, 'the done look-ahead cell costs nothing');
  assertEquals(h.background.length, 0);
  await h.fill.settled();
  assertEquals(h.fetches.length, 0);
  assertEquals(h.budgets, 0, 'the shared budget is untouched');
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'released', ways: 0 }]);
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.claims.length, 2, 'remembered as filling: no second claim within FILLING_MEMO_MS');
});

Deno.test('a failing user budget check counts as refused: released, logged without the user', async () => {
  const h = harness({ claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done') });
  h.db.takeRateLimit = () => Promise.reject(new Error('connection refused'));
  assertEquals(await h.fill.ensure([TILE], UID), [true]);
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'released', ways: 0 }]);
  assertEquals(h.background.length, 0);
  const err = h.logs.find((l) => l.level === 'error');
  assertEquals(err?.args[0], 'speed-limits osm fill budget check failed');
  assert(!JSON.stringify(h.logs).includes(UID), 'no user in the log');
});

Deno.test('one request claims at most MAX_CLAIMS_PER_REQUEST cells, its own cells first', async () => {
  assertEquals(MAX_CLAIMS_PER_REQUEST, 6);
  // four boxes in four different cells, each with neighbours within 1.5 km: far more than six cells in reach
  const boxes = [0, 1, 2, 3].map((i) => ({ minLat: 47.601 + i * 0.1, maxLat: 47.601 + i * 0.1, minLng: -122.399, maxLng: -122.399 }));
  const h = harness({ claim: () => 'done' });
  assertEquals(await h.fill.ensure(boxes, UID), [false, false, false, false]);
  assertEquals(h.claims.map(cellKey), ['476/-1224', '477/-1224', '478/-1224', '479/-1224', '475/-1225', '475/-1224']);
  // own cells past the cap are not claimed, so their tiles read as not loaded
  const many = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ minLat: 47.65 + i * 0.1, maxLat: 47.65 + i * 0.1, minLng: -122.35, maxLng: -122.35 }));
  const h2 = harness({ claim: () => 'done' });
  assertEquals(await h2.fill.ensure(many, UID), [false, false, false, false, false, false, true]);
  assertEquals(h2.claims.length, 6);
});

Deno.test('look-ahead names only the immediate neighbours, at most MAX_LOOKAHEAD_CELLS, however far the longitude scale stretches', () => {
  assertEquals(MAX_LOOKAHEAD_CELLS, 8);
  // at 85 degrees a 1.5 km look-ahead spans nearly two cells of longitude: still only the neighbours
  const far = { minLat: 85.001, maxLat: 85.001, minLng: 10.001, maxLng: 10.001 };
  const ahead = lookaheadCells(far);
  assert(ahead.length <= 8);
  assert(ahead.every((c) => Math.abs(c.y - 850) <= 1 && Math.abs(c.x - 100) <= 1 && !(c.y === 850 && c.x === 100)));
  // a box across a corner at 85 degrees: four own cells, the stretch reaches two columns either side, only the adjacent ones are named
  const corner = lookaheadCells({ minLat: 84.999, maxLat: 85.001, minLng: 9.999, maxLng: 10.001 });
  assertEquals(corner, [{ y: 849, x: 98 }, { y: 849, x: 101 }, { y: 850, x: 98 }, { y: 850, x: 101 }]);
  // a box 5 km inside its cells reaches nothing
  assertEquals(lookaheadCells({ minLat: 47.595, maxLat: 47.605, minLng: -122.405, maxLng: -122.395 }), []);
  // expand never scales past MAX_LAT
  const e = expand({ minLat: 89, maxLat: 89.5, minLng: 0, maxLng: 1 }, 1500);
  assert(e.maxLng - 1 < 0.2 && -e.minLng < 0.2);
});

Deno.test('a box beyond Web Mercator, off the globe or inside out is not fillable: no claim, reads not filling', async () => {
  assertEquals(MAX_LAT, 85.05112878);
  assert(fillable(TILE));
  assert(!fillable({ minLat: 85.1, maxLat: 85.1, minLng: 0, maxLng: 0 }));
  assert(!fillable({ minLat: -86, maxLat: -85.5, minLng: 0, maxLng: 0 }));
  assert(!fillable({ minLat: 0, maxLat: 0, minLng: 180.5, maxLng: 180.5 }));
  assert(!fillable({ minLat: 1, maxLat: 0, minLng: 0, maxLng: 0 }));
  assert(!fillable({ minLat: Number.NaN, maxLat: 0, minLng: 0, maxLng: 0 }));
  const h = harness();
  assertEquals(await h.fill.ensure([{ minLat: 86, maxLat: 86, minLng: 0, maxLng: 0 }, TILE], UID), [false, true]);
  assertEquals(h.claims.map(cellKey), ['476/-1224', '475/-1224']);
});

Deno.test("the device's fill cell (the warm-up's) is the server's cell, edges included", () => {
  for (const [lat, lng] of [[47.6062, -122.3321], [47.7, -122.3], [-33.8688, 151.2093], [0, 0], [0.1, -0.1], [64.99999, -147.7]]) {
    assertEquals(fillCellKey(lat, lng), cellKey(cellOf(lat, lng)));
  }
});

// --- the Overpass instances' usage policies ---

Deno.test("overpass-api.de's regular-use policy as budgets: 100 queries and 10 MiB a day, one start per 2 minutes; 60 s off after a refusal", () => {
  assertEquals(OVERPASS_DE_QUERIES, { key: 'overpass_de_queries', window: '1 day', max: 100 });
  assertEquals(OVERPASS_DE_MIB, { key: 'overpass_de_mib', window: '1 day', max: 10 });
  assertEquals(OVERPASS_DE_START, { key: 'overpass_de_start', window: '2 minutes', max: 1 });
  assertEquals(REFUSED_COOLDOWN_MS, 60_000);
});

Deno.test('private.coffee answering costs only the app-wide fill budget; the main instance is never asked', async () => {
  const h = harness({ claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done') });
  await h.fill.ensure([TILE], UID);
  await h.fill.settled();
  assertEquals(h.fetches.map((f) => f.url), [PRIVATE_COFFEE]);
  assertEquals(h.globalKeys, [OVERPASS_BUDGET.key]);
});

Deno.test('a 429 from private.coffee falls back to the main instance under its budgets, and private.coffee rests 60 s', async () => {
  const h = harness({
    claim: () => 'claimed',
    answers: [
      () => new Response('busy', { status: 429 }),
      () => new Response(body(replyOf([1])), { status: 200 }),
      () => new Response(body(replyOf([2])), { status: 200 }),
      () => new Response(body(replyOf([3])), { status: 200 }),
    ],
  });
  await h.fill.ensure([TILE], UID); // SEATTLE, then its look-ahead SOUTH
  await h.fill.settled();
  // SEATTLE: private.coffee refuses, the main instance answers; SOUTH: private.coffee is resting, so the main instance alone
  assertEquals(h.fetches.map((f) => f.url), [PRIVATE_COFFEE, OVERPASS_DE, OVERPASS_DE]);
  assertEquals(h.globalKeys, [
    OVERPASS_BUDGET.key, OVERPASS_DE_START.key, OVERPASS_DE_QUERIES.key,
    OVERPASS_BUDGET.key, OVERPASS_DE_START.key, OVERPASS_DE_QUERIES.key,
  ]);
  assertEquals(h.finishes.map((f) => f.outcome), ['done', 'done']);
});

Deno.test('with private.coffee refusing and the main instance over its daily budget, the cell is released (claimable again), not failed', async () => {
  const h = harness({
    claim: (c) => (c.y === SEATTLE.y ? 'claimed' : 'done'),
    global: (key) => key !== OVERPASS_DE_QUERIES.key,
    answers: [() => new Response('busy', { status: 429 })],
  });
  await h.fill.ensure([TILE], UID);
  await h.fill.settled();
  assertEquals(h.fetches.map((f) => f.url), [PRIVATE_COFFEE]);
  assertEquals(h.finishes, [{ cell: SEATTLE, outcome: 'released', ways: 0 }]);
  assertEquals(h.logs.filter((l) => l.level === 'error').length, 0);
});
