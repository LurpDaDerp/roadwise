/** @jest-environment node */
import { createSupabaseSpeedLimitApi, type SpeedLimitApi } from '@/core/speedLimits/api';
import {
  createSpeedLimitClient,
  MIN_MOVING_MPS,
  STICKY_RADIUS_M,
  TRUNCATED_CONFIDENCE_CAP,
  TRUNCATED_TILE_TTL_MS,
  UNKNOWN_ROWS_BEFORE_POINT_LOOKUP,
  type SpeedLimitClient,
} from '@/core/speedLimits/client';
import { prefetchSet, tileBounds, tileFor, tileKey } from '@/core/speedLimits/tiles';
import { type LimitSegment, MAX_TILE_TTL_MS, type PointResponse, type TileBatchResponse } from '@/core/speedLimits/wire';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createTilesRepo } from '@/data/db/tiles';
import { encodePolyline } from '@/lib/polyline';
import { mphToMps } from '@/lib/units';

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;
const M_PER_DEG = 111_320;
const LAT = 47.6062;
const LNG0 = -122.3321; // the speeding-corrected trace's start
const EAST = 90;
const mLng = (m: number): number => m / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180));
const mLat = (m: number): number => m / M_PER_DEG;
const keyAt = (lat: number, lng: number): string => tileKey(tileFor(lat, lng));

/** The fixture corridor: one east-west road, 35 mph. */
const road = (over: Partial<LimitSegment> = {}): LimitSegment => ({
  id: 'corridor',
  provider: 'osm',
  limitMph: 35,
  highway: 'primary',
  oneway: 0,
  line: encodePolyline([
    { lat: LAT, lng: -122.333 },
    { lat: LAT, lng: -122.299 },
  ]),
  ...over,
});

const MOVING = { gnssValid: true, speedMps: 20 };
const STOPPED = { gnssValid: true, speedMps: 0.5 };

let clock: number;
let db: Db;
let selects: number;
let writes: number;
let client: SpeedLimitClient;
let errors: unknown[];
let online: boolean;

interface FakeOptions {
  segmentsFor?: (key: string) => LimitSegment[];
  truncated?: boolean;
  fallback?: 'aws' | null;
  point?: PointResponse;
  expiresIn?: number;
}

function fakeApi(opts: FakeOptions = {}) {
  const segmentsFor = opts.segmentsFor ?? (() => [road()]);
  const getTiles = jest.fn(
    async (keys: string[]): Promise<TileBatchResponse> => ({
      tiles: keys.map((tile) => ({
        tile,
        expiresAt: clock + (opts.expiresIn ?? DAY),
        truncated: opts.truncated ?? false,
        segments: segmentsFor(tile),
      })),
      fallback: opts.fallback ?? null,
    })
  );
  const lookupPoint = jest.fn(
    async (): Promise<PointResponse> =>
      opts.point ?? { limitMph: null, source: 'unknown', matchConfidence: 0, parallelRoads: false, provider: null }
  );
  return { api: { getTiles, lookupPoint } satisfies SpeedLimitApi, getTiles, lookupPoint };
}

function make(api: SpeedLimitApi, extra: { persist?: boolean } = {}): SpeedLimitClient {
  client = createSpeedLimitClient({
    ...extra,
    db,
    api,
    now: () => clock,
    online: () => online,
    onError: (e) => errors.push(e),
  });
  return client;
}

beforeEach(async () => {
  clock = T0;
  errors = [];
  online = true;
  selects = 0;
  writes = 0;
  const raw = await createSqlJsDb();
  await migrate(raw);
  // Count every tile read (`getTile`'s SELECT) — the recovery test's measure (rev1: I7).
  db = {
    execute: (sql, params) => {
      if (/SELECT \* FROM speed_limit_tiles/.test(sql)) selects += 1;
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes += 1;
      return raw.execute(sql, params);
    },
    transaction: (fn) => raw.transaction(fn),
  };
});

const store = (key: string, segments: unknown[], expiresAt = clock + DAY) =>
  createTilesRepo(db).putTile(key, expiresAt, segments);

describe('the network budget (§3.5, R7)', () => {
  it('startTrip sends one batch of the prefetch set: current, next along course, and lateral', async () => {
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST);
    client.prefetch(LAT, LNG0, EAST); // the engine's first-fix prefetch: those keys are in flight
    await client.settled();

    expect(getTiles).toHaveBeenCalledTimes(1);
    const keys = getTiles.mock.calls[0]![0];
    expect(keys).toEqual(prefetchSet(LAT, LNG0, EAST).map(tileKey));
    expect(keys).toEqual(['15/5249/11443', '15/5250/11443', '15/5249/11444', '15/5250/11444']);
    expect(client.stats().requestsThisTrip).toBe(1);
  });

  it('drives 2 km with one batch per km at most, lookups never touch the network, and the limit is known', async () => {
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST);
    const perCall: number[] = [];
    let known = 0;
    let rows = 0;
    for (let m = 0; m <= 2000; m += 25) {
      const lng = LNG0 + mLng(m);
      if (m % 1000 === 0) {
        const before = getTiles.mock.calls.length;
        client.prefetch(LAT, lng, EAST);
        await client.settled();
        perCall.push(getTiles.mock.calls.length - before);
      }
      const before = getTiles.mock.calls.length;
      const s = client.lookup(LAT, lng, EAST, MOVING);
      await client.settled();
      expect(getTiles.mock.calls.length).toBe(before);
      rows += 1;
      if (s?.limitMps != null) known += 1;
    }
    expect(perCall.every((n) => n <= 1)).toBe(true);
    expect(getTiles.mock.calls.length).toBeLessThanOrEqual(1 + perCall.length);
    const all = getTiles.mock.calls.flatMap((c) => c[0]);
    expect(new Set(all).size).toBe(all.length); // no tile fetched twice
    expect(known / rows).toBeGreaterThanOrEqual(0.9);
  });

  it('asks only for tiles neither in memory nor fresh in SQLite, and not at all when every one is', async () => {
    const set = prefetchSet(LAT, LNG0, EAST).map(tileKey);
    await store(set[0]!, [road()]);
    await store(set[1]!, [road()]);
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(getTiles).toHaveBeenCalledTimes(1);
    expect(getTiles.mock.calls[0]![0]).toEqual(set.slice(2));

    client.prefetch(LAT, LNG0, EAST);
    await client.settled();
    expect(getTiles).toHaveBeenCalledTimes(1);
  });

  it('refetches a tile that expired in SQLite, and one that expired in memory', async () => {
    const set = prefetchSet(LAT, LNG0, EAST).map(tileKey);
    for (const k of set) await store(k, [road()], clock - 1);
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(getTiles.mock.calls[0]![0]).toEqual(set);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)?.limitMps).toBeCloseTo(mphToMps(35));

    clock += DAY + 1; // every tile the fake served has now expired
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull();
    client.prefetch(LAT, LNG0, EAST);
    await client.settled();
    expect(getTiles).toHaveBeenCalledTimes(2);
    expect(getTiles.mock.calls[1]![0]).toEqual(set);
  });

  it('stores a fetched tile with its expiry capped at 30 days', async () => {
    const { api } = fakeApi({ expiresIn: 60 * DAY });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    const { rows } = await db.execute('SELECT tile_key, expires_at FROM speed_limit_tiles');
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.expires_at).toBe(T0 + MAX_TILE_TTL_MS);
  });

  it('makes zero requests offline, and still serves tiles from SQLite', async () => {
    online = false;
    await store(keyAt(LAT, LNG0), [road({ limitMph: null })]);
    const { api, getTiles, lookupPoint } = fakeApi({ fallback: 'aws' });
    make(api).startTrip(LAT, LNG0, EAST);
    client.prefetch(LAT, LNG0, EAST);
    for (let i = 0; i < 20; i += 1) {
      client.lookup(LAT, LNG0 + mLng(i * 5), EAST, MOVING);
      await client.settled();
    }
    expect(getTiles).not.toHaveBeenCalled();
    expect(lookupPoint).not.toHaveBeenCalled();
    expect(client.stats().requestsThisTrip).toBe(0);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toMatchObject({ source: 'unknown', limitMps: null });
  });

  it('a batch the contract rejects is reported, stores nothing, and the next prefetch asks again', async () => {
    const invoke = jest.fn(async () => ({ data: { tiles: [], fallback: null, extra: true }, error: null }));
    make(createSupabaseSpeedLimitApi({ functions: { invoke } })).startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(errors).toHaveLength(1);
    expect(await createTilesRepo(db).count()).toBe(0);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull();

    client.prefetch(LAT, LNG0, EAST);
    await client.settled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('ignores a tile in the reply that it did not ask for', async () => {
    const { api } = fakeApi();
    api.getTiles.mockImplementationOnce(async (keys: string[]) => ({
      tiles: [...keys, '15/1/1'].map((tile) => ({ tile, expiresAt: clock + DAY, truncated: false, segments: [] })),
      fallback: null,
    }));
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    await expect(createTilesRepo(db).getTile('15/1/1', clock)).resolves.toBeNull();
  });
});

describe('memory (rev1: I6, I7)', () => {
  it('uses a tile already in SQLite on a memory miss, without a network call', async () => {
    await store(keyAt(LAT, LNG0), [road()]);
    const { api, getTiles } = fakeApi();
    make(api);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull(); // not in memory yet: null now
    await client.settled();
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toEqual({
      limitMps: mphToMps(35),
      source: 'posted',
      matchConfidence: 0.95,
      parallelRoads: false,
    });
    expect(getTiles).not.toHaveBeenCalled();
    expect(client.stats()).toMatchObject({ sqliteLoads: 1, memoryTiles: 1, requestsThisTrip: 0 });
  });

  it('looks a tile up in SQLite once when it is not there, not on every row', async () => {
    make(fakeApi().api);
    for (let i = 0; i < 100; i += 1) {
      expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull();
      await client.settled();
    }
    expect(selects).toBe(1);
  });

  it('holds at most 12 decoded tiles, evicting the least recently used', async () => {
    const t0 = tileFor(LAT, LNG0);
    const points = Array.from({ length: 13 }, (_, i) => {
      const b = tileBounds({ ...t0, x: t0.x + i });
      return { lat: LAT, lng: (b.minLng + b.maxLng) / 2 };
    });
    for (const p of points) await store(keyAt(p.lat, p.lng), [road()]);
    make(fakeApi().api);
    for (const p of points) await client.lookupStored(p.lat, p.lng, EAST);
    expect(client.stats().memoryTiles).toBe(12);
    expect(selects).toBe(13);
    await client.lookupStored(points[12]!.lat, points[12]!.lng, EAST); // still held
    expect(selects).toBe(13);
    await client.lookupStored(points[0]!.lat, points[0]!.lng, EAST); // evicted: read again
    expect(selects).toBe(14);
  });

  it('matches against every tile in memory near the point, not only the one it falls in', async () => {
    // The corridor is 4.1 m north of the edge between rows 11443 and 11444. Put the road only in
    // the northern tile and stand 3 m south of the edge, in a southern tile that holds nothing.
    const north = tileFor(LAT, LNG0);
    const edge = tileBounds(north).minLat;
    const p = { lat: edge - mLat(3), lng: LNG0 };
    expect(keyAt(p.lat, p.lng)).toBe(tileKey({ ...north, y: north.y + 1 }));
    await store(tileKey(north), [road()]);
    await store(keyAt(p.lat, p.lng), []);
    make(fakeApi().api);
    await client.lookupStored(LAT, LNG0, EAST);
    await client.lookupStored(p.lat, p.lng, EAST);
    expect(client.lookup(p.lat, p.lng, EAST, MOVING)?.limitMps).toBeCloseTo(mphToMps(35));
  });

  it('recovering a 3600-row trip across 3 tiles reads each tile from SQLite once', async () => {
    const end = -122.3009;
    for (const x of [5249, 5250, 5251]) await store(`15/${x}/11443`, [road()]);
    make(fakeApi().api);
    const rows = Array.from({ length: 3600 }, (_, i) => LNG0 + ((end - LNG0) * i) / 3599);
    expect(new Set(rows.map((lng) => keyAt(LAT, lng))).size).toBe(3);

    let known = 0;
    for (const lng of rows) {
      const s = await client.lookupStored(LAT, lng, EAST);
      if (s?.limitMps === mphToMps(35)) known += 1;
    }
    expect(selects).toBe(3);
    expect(client.stats().sqliteLoads).toBe(3);
    expect(known).toBe(3600);
  });

  it('concurrent recovery lookups share one read per tile', async () => {
    for (const x of [5249, 5250, 5251]) await store(`15/${x}/11443`, [road()]);
    make(fakeApi().api);
    const rows = Array.from({ length: 300 }, (_, i) => LNG0 + ((-122.3009 - LNG0) * i) / 299);
    const out = await Promise.all(rows.map((lng) => client.lookupStored(LAT, lng, EAST)));
    expect(selects).toBe(3);
    expect(out.every((s) => s?.source === 'posted')).toBe(true);
  });

  it('lookupStored is null for a tile that was never stored', async () => {
    make(fakeApi().api);
    await expect(client.lookupStored(LAT, LNG0, EAST)).resolves.toBeNull();
  });
});

describe('honesty (§13.2, rev1: I8)', () => {
  async function loaded(segments: LimitSegment[] = [road()]) {
    await store(keyAt(LAT, LNG0), segments);
    make(fakeApi().api);
    await client.lookupStored(LAT, LNG0, EAST);
  }

  it('an invalid fix is unknown even right after a match, and the match does not come back', async () => {
    await loaded();
    expect(client.lookup(LAT, LNG0, EAST, MOVING)?.limitMps).toBeCloseTo(mphToMps(35));
    // A tunnel: the row keeps the last fix's position, course -1, no speed.
    expect(client.lookup(LAT, LNG0, -1, { gnssValid: false, speedMps: null })).toBeNull();
    expect(client.lookup(LAT, LNG0, EAST, { gnssValid: false, speedMps: 20 })).toBeNull();
    // Out of the tunnel, stopped with no course: the pre-tunnel match is not carried over.
    expect(client.lookup(LAT, LNG0, -1, STOPPED)).toBeNull();
  });

  it('stopped with no course, the previous match holds within 30 m and nowhere else', async () => {
    await loaded();
    const match = client.lookup(LAT, LNG0, EAST, MOVING);
    expect(match?.source).toBe('posted');
    expect(STICKY_RADIUS_M).toBe(30);
    expect(MIN_MOVING_MPS).toBe(2);
    expect(client.lookup(LAT, LNG0 + mLng(10), -1, STOPPED)).toEqual(match);
    expect(client.lookup(LAT, LNG0 + mLng(40), -1, STOPPED)).toBeNull();
    expect(client.lookup(LAT, LNG0, -1, { gnssValid: true, speedMps: 5 })).toBeNull();
    expect(client.lookup(LAT, LNG0, -1, { gnssValid: true, speedMps: null })).toBeNull();
  });

  it('an untagged road is unknown — no number, confidence 0', async () => {
    await loaded([road({ limitMph: null })]);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toEqual({
      limitMps: null,
      source: 'unknown',
      matchConfidence: 0,
      parallelRoads: false,
    });
  });

  it("returns the matcher's confidence unaltered (the HUD shows a limit only at ≥ 0.8)", async () => {
    const parallel = road({
      id: 'frontage',
      limitMph: 25,
      highway: 'service',
      line: encodePolyline([
        { lat: LAT + mLat(8), lng: -122.333 },
        { lat: LAT + mLat(8), lng: -122.299 },
      ]),
    });
    await loaded([road(), parallel]);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toEqual({
      limitMps: mphToMps(35),
      source: 'posted',
      matchConfidence: 0.6,
      parallelRoads: true,
    });
  });

  it('a lookup with no tile in memory is null — never a guess', async () => {
    make(fakeApi().api);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull();
  });
});

describe('point lookups (R7: only with fallback aws, charged to the per-km budget)', () => {
  const answer: PointResponse = {
    limitMph: 40,
    source: 'cached',
    matchConfidence: 0.7,
    parallelRoads: false,
    provider: 'aws',
  };
  const untagged = () => [road({ limitMph: null })];

  async function drive(from: number, rows: number, opts = MOVING): Promise<(ReturnType<SpeedLimitClient['lookup']>)[]> {
    const out = [];
    for (let i = 0; i < rows; i += 1) {
      out.push(client.lookup(LAT, LNG0 + mLng(from + i * 20), EAST, opts));
      await client.settled();
    }
    return out;
  }

  it('never happens when the server has said there is no fallback', async () => {
    const { api, lookupPoint } = fakeApi({ segmentsFor: untagged, fallback: null, point: answer });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    await drive(0, 20);
    expect(lookupPoint).not.toHaveBeenCalled();
  });

  it('with fallback aws: after 5 unknown moving rows, once per km, and its answer is used', async () => {
    const { api, lookupPoint } = fakeApi({ segmentsFor: untagged, fallback: 'aws', point: answer });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(UNKNOWN_ROWS_BEFORE_POINT_LOOKUP).toBe(5);

    await drive(0, 4);
    expect(lookupPoint).not.toHaveBeenCalled();
    await drive(80, 1); // the fifth
    expect(lookupPoint).toHaveBeenCalledTimes(1);
    expect(lookupPoint.mock.calls[0]).toEqual([{ lat: LAT, lng: LNG0 + mLng(80), heading: EAST, radiusM: 25 }]);

    // The answer covers the road ahead of where it was asked, in this direction.
    const [ahead] = await drive(180, 1);
    expect(ahead).toEqual({ limitMps: mphToMps(40), source: 'cached', matchConfidence: 0.7, parallelRoads: false });
    expect(client.lookup(LAT, LNG0 + mLng(180), 270, MOVING)?.source).toBe('unknown'); // the other way

    // Past it, unknown again — but this km's lookup is spent.
    await drive(400, 10);
    expect(lookupPoint).toHaveBeenCalledTimes(1);
    // The next km's prefetch makes one more available.
    client.prefetch(LAT, LNG0 + mLng(600), EAST);
    await client.settled();
    await drive(620, 1);
    expect(lookupPoint).toHaveBeenCalledTimes(2);
    // requestsThisTrip counts every network request: the batches and the point lookups.
    expect(client.stats()).toMatchObject({
      pointLookupsThisTrip: 2,
      requestsThisTrip: api.getTiles.mock.calls.length + 2,
    });
  });

  it('not while slow, and an unknown answer caches nothing', async () => {
    const { api, lookupPoint } = fakeApi({ segmentsFor: untagged, fallback: 'aws' });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    await drive(0, 10, { gnssValid: true, speedMps: 1 });
    expect(lookupPoint).not.toHaveBeenCalled();
    await drive(0, 6);
    expect(lookupPoint).toHaveBeenCalledTimes(1);
    const [next] = await drive(120, 1);
    expect(next?.source).toBe('unknown');
  });

  it('a failed point lookup is reported and the drive carries on', async () => {
    const { api, lookupPoint } = fakeApi({ segmentsFor: untagged, fallback: 'aws' });
    lookupPoint.mockRejectedValueOnce(new Error('offline'));
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    await drive(0, 6);
    expect(errors).toHaveLength(1);
    expect(client.lookup(LAT, LNG0, EAST, MOVING)?.source).toBe('unknown');
  });
});

describe('lifecycle', () => {
  it('purgeExpired delegates to the tiles repository', async () => {
    await store('15/1/1', [], clock - 1);
    await store('15/1/2', [], clock + DAY);
    make(fakeApi().api);
    await expect(client.purgeExpired()).resolves.toBe(1);
    expect(await createTilesRepo(db).count()).toBe(1);
  });

  it("resetTrip clears the trip's counters and memory; a reply arriving after it is stored, not held", async () => {
    const { api } = fakeApi();
    const real = api.getTiles.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = () => r()));
    api.getTiles.mockImplementationOnce(async (keys: string[]) => {
      await gate;
      return real(keys);
    });
    make(api).startTrip(LAT, LNG0, EAST);
    while (api.getTiles.mock.calls.length === 0) await new Promise<void>((r) => setImmediate(() => r()));
    expect(client.stats().requestsThisTrip).toBe(1);

    client.resetTrip();
    release();
    await client.settled();
    expect(await createTilesRepo(db).count()).toBe(4);
    expect(client.stats()).toEqual({
      memoryTiles: 0,
      requestsThisTrip: 0,
      pointLookupsThisTrip: 0,
      sqliteLoads: 0,
      truncatedTiles: 0,
    });
    expect(client.lookup(LAT, LNG0, EAST, MOVING)).toBeNull();
  });

  it('a batch whose trip was reset before it was sent is never sent', async () => {
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST); // still checking SQLite
    client.resetTrip();
    await client.settled();
    expect(getTiles).not.toHaveBeenCalled();
  });
});

describe('fix round 1', () => {
  /** A tagged 25 mph frontage road 8 m north of the corridor — the car's own road is the corridor. */
  const frontage = () =>
    road({
      id: 'frontage',
      limitMph: 25,
      highway: 'service',
      line: encodePolyline([
        { lat: LAT + mLat(8), lng: -122.333 },
        { lat: LAT + mLat(8), lng: -122.299 },
      ]),
    });

  it('C-R1: a simulated drive (persist: false) writes nothing to SQLite, and still reads it', async () => {
    await store(keyAt(LAT, LNG0), [road()]);
    await store('15/1/1', [], clock - 1);
    writes = 0;
    const { api, getTiles } = fakeApi();
    make(api, { persist: false }).startTrip(LAT, LNG0, EAST);
    await client.settled();
    for (let m = 0; m <= 2000; m += 25) {
      if (m % 1000 === 0) client.prefetch(LAT, LNG0 + mLng(m), EAST);
      client.lookup(LAT, LNG0 + mLng(m), EAST, MOVING);
      await client.settled();
    }
    expect(getTiles).toHaveBeenCalled(); // tiles were fetched and used in memory…
    expect(client.lookup(LAT, LNG0 + mLng(2000), EAST, MOVING)?.limitMps).toBeCloseTo(mphToMps(35));
    await expect(client.purgeExpired()).resolves.toBe(0);
    expect(writes).toBe(0); // …but nothing was stored or deleted
    expect(await createTilesRepo(db).count()).toBe(2);
    expect(client.stats().sqliteLoads).toBeGreaterThan(0); // the stored tile was read
  });

  it('C-R4: a truncated tile keeps its flag in the stored payload and lives about a day', async () => {
    const { api } = fakeApi({ truncated: true, expiresIn: 20 * DAY });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    const { rows } = await db.execute('SELECT expires_at, segments_json FROM speed_limit_tiles');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.expires_at).toBe(T0 + TRUNCATED_TILE_TTL_MS);
      expect(JSON.parse(r.segments_json as string)).toEqual({ truncated: true, segments: [road()] });
    }
    expect(TRUNCATED_TILE_TTL_MS).toBe(24 * 3600 * 1000);
    expect(client.stats().truncatedTiles).toBe(4);
  });

  it('C-R4: a truncated tile is not refetched each kilometre, nor on the next trip that day', async () => {
    const { api, getTiles } = fakeApi({ truncated: true });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    client.prefetch(LAT, LNG0, EAST);
    await client.settled();
    client.resetTrip();
    clock += 12 * 3600 * 1000;
    client.startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(getTiles).toHaveBeenCalledTimes(1);
    expect(client.stats().truncatedTiles).toBe(4); // reloaded from SQLite with the flag
  });

  it('C-R4: a stored plain segment array (before the envelope) reads as not truncated', async () => {
    await store(keyAt(LAT, LNG0), [road()]);
    make(fakeApi().api);
    const s = await client.lookupStored(LAT, LNG0, EAST);
    expect(s?.matchConfidence).toBe(0.95);
    expect(client.stats().truncatedTiles).toBe(0);
  });

  it("I1: a truncated tile that dropped the car's road but kept a parallel one never answers confidently", async () => {
    // Untruncated, the same tile would name the frontage road's 25 mph at 0.95 — the wrong limit,
    // confidently. That is exactly what truncation can produce, so the flag must hold it down.
    const own = keyAt(LAT, LNG0);
    await createTilesRepo(db).putTile(own, clock + DAY, { truncated: false, segments: [frontage()] });
    make(fakeApi().api);
    expect((await client.lookupStored(LAT, LNG0, EAST))?.matchConfidence).toBe(0.95);

    await createTilesRepo(db).putTile(own, clock + DAY, { truncated: true, segments: [frontage()] });
    make(fakeApi().api);
    await client.lookupStored(LAT, LNG0, EAST);
    const s = client.lookup(LAT, LNG0, EAST, MOVING);
    expect(s?.limitMps).toBeCloseTo(mphToMps(25));
    expect(s!.matchConfidence).toBeLessThanOrEqual(TRUNCATED_CONFIDENCE_CAP);
    expect(TRUNCATED_CONFIDENCE_CAP).toBe(0.6);
  });

  it('I1: a truncated tile holds the confidence down however the tile came, and rows near it count toward a point lookup', async () => {
    const { api, lookupPoint } = fakeApi({ truncated: true, fallback: 'aws', segmentsFor: () => [frontage()] });
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    for (let i = 0; i < 5; i += 1) {
      const s = client.lookup(LAT, LNG0 + mLng(i * 20), EAST, MOVING);
      expect(s!.matchConfidence).toBeLessThanOrEqual(0.6);
      await client.settled();
    }
    expect(lookupPoint).toHaveBeenCalledTimes(1);
  });

  it('M2: offline, a prefetch preloads the tiles ahead from SQLite, so a tile edge costs no null row', async () => {
    online = false;
    const set = prefetchSet(LAT, LNG0, EAST).map(tileKey);
    for (const k of set) await store(k, [road()]);
    const { api, getTiles } = fakeApi();
    make(api).startTrip(LAT, LNG0, EAST);
    await client.settled();
    expect(client.stats().memoryTiles).toBe(4);
    // The next tile east, entered for the first time: answered at once, not null.
    const next = tileBounds(tileFor(LAT, LNG0));
    const lng = next.maxLng + mLng(5);
    expect(keyAt(LAT, lng)).toBe(set[1]);
    expect(client.lookup(LAT, lng, EAST, MOVING)?.limitMps).toBeCloseTo(mphToMps(35));
    expect(getTiles).not.toHaveBeenCalled();
  });
});
