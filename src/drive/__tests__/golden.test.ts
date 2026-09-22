/** @jest-environment node */
/**
 * The M3 milestone golden, in process: the whole drive flow from native events to the queued,
 * provisionally scored upload, with real speed limits.
 *
 *   fake drive-sense ──rows──▶ drive host (full persistence, sql.js) ──▶ engine, detectors, arbiter
 *                                   │                                   │
 *                                   ├─ speed-limit client ◀─ fake API serving tiles built from a
 *                                   │   (real, over the same db)        TS copy of supabase/seed.sql
 *                                   ├─ fake alert player (records what it was handed)
 *                                   └─ finalize → trips, trip_events, trace (gzip), sync_queue
 *
 * Two drives, as a device would record them: `speeding-corrected.json`, then `phone-pickup.json`
 * an hour later. Every expectation about stored rows, trace bytes and `rows_digest` is built from
 * the rows as `parseRow` rounds them at the bridge (D2), because that is what the host records.
 *
 * `scripts/e2e-drive.js` is the same flow against the local stack's real functions.
 */
import * as scoring from '@scoring';
import { createFakeDriveSense, parseRow, type FeatureRow } from '@drive-sense';
import { gunzipSync } from 'fflate';

import { gzip } from '@/boot/gzip';
import type { AlertDecision } from '@/core/alerts/types';
import { sha256, TZ } from '@/core/engine/__fixtures__/drives';
import { canonicalJson, tracePathFor } from '@/core/engine/finalize';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitApi } from '@/core/speedLimits/api';
import { createSpeedLimitClient, type SpeedLimitClient } from '@/core/speedLimits/client';
import { parseTileKey, tileBounds, tileFor, tileKey } from '@/core/speedLimits/tiles';
import {
  MAX_TILE_TTL_MS,
  TileBatchResponseSchema,
  type LimitSegment,
  type TileBatchResponse,
} from '@/core/speedLimits/wire';
import { createEventsRepo, createTripsRepo, migrate, type Db, type TripRow } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { FinalizeTripPayloadSchema, type FinalizeTripPayload } from '@/data/sync/payload';
import { finalizeIdempotencyKey } from '@/data/sync/queue';
import { createDriveHost, type DriveHost } from '@/drive/host';
import type { Scheduler } from '@/drive/ticks';
import { encodePolyline } from '@/lib/polyline';
import { mphToMps } from '@/lib/units';

import speedingTrace from '@/core/__fixtures__/traces/speeding-corrected.json';
import phoneTrace from '@/core/__fixtures__/traces/phone-pickup.json';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the root
// tsconfig's `types` is ["jest"], hence local shapes (the pattern of `replay/__tests__`).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { readFileSync } = require('node:fs') as { readFileSync: (file: string, encoding: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

// --- the seed fixture, copied ---------------------------------------------------------------------

/**
 * `supabase/seed.sql`'s synthetic speed-limit fixture, as the tiles function would read it. The
 * first test parses the SQL and holds this copy to it, so the golden cannot drift from the seed the
 * e2e golden and pgTAP use.
 */
interface SeedRoad {
  id: string;
  provider: 'osm' | 'hpms';
  highway: string;
  limitMph: number | null;
  oneway: -1 | 0 | 1;
  /** [lng, lat] in digitised order, as the WKT has it. */
  coords: readonly (readonly [number, number])[];
}

const SEED: readonly SeedRoad[] = [
  { id: '9000000001', provider: 'osm', highway: 'primary', limitMph: 35, oneway: 0, coords: [[-122.333, 47.6062], [-122.299, 47.6062]] },
  { id: '9000000002', provider: 'osm', highway: 'residential', limitMph: 25, oneway: 0, coords: [[-122.333, 47.60638], [-122.299, 47.60638]] },
  { id: '9000000003', provider: 'osm', highway: 'primary_link', limitMph: 25, oneway: 1, coords: [[-122.3005, 47.6062], [-122.2995, 47.604]] },
  { id: '9000000004', provider: 'osm', highway: 'residential', limitMph: null, oneway: 0, coords: [[-122.32, 47.604], [-122.32, 47.6085]] },
  // HPMS sections come back from the tiles function as `road`, two-way (B1).
  { id: '9000000101', provider: 'hpms', highway: 'road', limitMph: 30, oneway: 0, coords: [[-122.32, 47.6045], [-122.32, 47.608]] },
];

const CORRIDOR_TILES = ['15/5249/11443', '15/5250/11443', '15/5251/11443'] as const;
const TILE_BUFFER_M = 30;
const M_PER_DEG = 111_320;
const TILE_TTL_MS = 30 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

const coordsOf = (wkt: string): [number, number][] =>
  wkt.split(',').map((pair) => {
    const [lng, lat] = pair.trim().split(/\s+/).map(Number);
    return [lng as number, lat as number];
  });

/** Every road `seed.sql` inserts, parsed from the SQL itself. */
function parseSeedSql(sql: string): SeedRoad[] {
  const roads: SeedRoad[] = [];
  const way =
    /\((\d+), extensions\.st_geomfromtext\('LINESTRING\(([^)]*)\)', 4326\), '([a-z_]+)', (null|\d+), (?:null|'[^']*'), '[^']*', (-?\d)\)/g;
  for (const m of sql.matchAll(way)) {
    roads.push({
      id: m[1] as string,
      provider: 'osm',
      highway: m[3] as string,
      limitMph: m[4] === 'null' ? null : Number(m[4]),
      oneway: Number(m[5]) as -1 | 0 | 1,
      coords: coordsOf(m[2] as string),
    });
  }
  const hpms = /\((\d+), extensions\.st_geomfromtext\('MULTILINESTRING\(\(([^)]*)\)\)', 4326\), (\d+), \d+, \d+, '[^']*'\)/g;
  for (const m of sql.matchAll(hpms)) {
    roads.push({ id: m[1] as string, provider: 'hpms', highway: 'road', limitMph: Number(m[3]), oneway: 0, coords: coordsOf(m[2] as string) });
  }
  return roads;
}

// --- tiles, built as speed_limit_tiles builds them (B1) -------------------------------------------

/** Liang–Barsky: the part of a–b inside the box, or null. Coordinates are [lng, lat]. */
function clipSegment(
  a: readonly [number, number],
  b: readonly [number, number],
  box: { minLng: number; minLat: number; maxLng: number; maxLat: number }
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - box.minLng],
    [dx, box.maxLng - a[0]],
    [-dy, a[1] - box.minLat],
    [dy, box.maxLat - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/**
 * One tile's segments: every seed road clipped to the tile grown by 30 m of ground (measured at
 * the poleward edge, as B1 does), snapped to 1e-5 with repeats removed, encoded at precision 5,
 * direction kept. The seed's roads are single straight lines, so each gives at most one part.
 */
function segmentsFor(key: string): LimitSegment[] {
  const b = tileBounds(parseTileKey(key)!);
  const dLat = TILE_BUFFER_M / M_PER_DEG;
  const dLng = TILE_BUFFER_M / (M_PER_DEG * Math.cos((b.maxLat * Math.PI) / 180));
  const box = { minLng: b.minLng - dLng, maxLng: b.maxLng + dLng, minLat: b.minLat - dLat, maxLat: b.maxLat + dLat };
  const out: LimitSegment[] = [];
  for (const road of SEED) {
    const pts: { lat: number; lng: number }[] = [];
    for (let i = 1; i < road.coords.length; i += 1) {
      const part = clipSegment(road.coords[i - 1]!, road.coords[i]!, box);
      if (!part) continue;
      for (const [lng, lat] of part) {
        const p = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
        const prev = pts[pts.length - 1];
        if (!prev || prev.lat !== p.lat || prev.lng !== p.lng) pts.push(p);
      }
    }
    if (pts.length < 2) continue;
    out.push({
      id: road.id,
      provider: road.provider,
      limitMph: road.limitMph,
      highway: road.highway,
      oneway: road.oneway,
      line: encodePolyline(pts),
    });
  }
  return out;
}

// --- the harness ---------------------------------------------------------------------------------

interface Lookup {
  ts: number;
  tile: string;
  sample: LimitSample | null;
}

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

function harness() {
  let clock = speedingTrace.rows[0]!.ts - 5_000;
  const timers = new Map<number, () => void>();
  let seq = 0;
  const scheduler: Scheduler = {
    setTimeout(fn) {
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };

  // The API the client talks to: tiles from the seed copy, every reply held to the wire contract.
  const batches: { at: number; keys: string[] }[] = [];
  const api: SpeedLimitApi = {
    getTiles: async (keys) => {
      batches.push({ at: clock, keys: [...keys] });
      const reply: TileBatchResponse = {
        tiles: keys.map((tile) => ({ tile, expiresAt: clock + TILE_TTL_MS, truncated: false, segments: segmentsFor(tile) })),
        fallback: null,
      };
      return TileBatchResponseSchema.parse(reply);
    },
    lookupPoint: async () => {
      throw new Error('no point lookup may happen: every batch said fallback null');
    },
  };
  const errors: { error: unknown; ctx: string }[] = [];
  const real = createSpeedLimitClient({
    db,
    api,
    now: () => clock,
    online: () => true,
    onError: (error) => errors.push({ error, ctx: 'limits' }),
  });
  // What the engine was told for each row, keyed by the tile the row fell in.
  const lookups: Lookup[] = [];
  let judging: FeatureRow | null = null;
  const limits: SpeedLimitClient = {
    ...real,
    lookup: (lat, lng, course, opts) => {
      const sample = real.lookup(lat, lng, course, opts);
      if (judging) lookups.push({ ts: judging.ts, tile: tileKey(tileFor(lat, lng)), sample });
      return sample;
    },
  };

  const delivered: AlertDecision[] = [];
  const player = {
    deliver: jest.fn(async (d: AlertDecision) => {
      delivered.push(d);
    }),
    stopCurrent: jest.fn(async () => {}),
    announce: jest.fn(async () => {}),
  };
  const traces = new Map<string, Uint8Array>();
  const traceWriter = {
    // The device's writer gzips what finalize hands it (D2); keep the compressed file.
    writeGzip: jest.fn(async (path: string, bytes: Uint8Array) => {
      traces.set(path, gzip(bytes));
    }),
    clear: async () => {},
  };
  const fake = createFakeDriveSense({ platform: 'ios', now: () => clock });
  fake.setState({ location: 'always', motion: 'granted' });
  let ids = 0;
  const host: DriveHost = createDriveHost({
    db,
    source: fake,
    limits,
    player,
    scoring,
    traceWriter,
    hash: { sha256 },
    now: () => clock,
    tz: () => TZ,
    newId: () => `golden-${(ids += 1)}`,
    persistence: 'full',
    scheduler,
    onError: (error, ctx) => errors.push({ error, ctx }),
  });

  // Alerts as the host raised them, in the order it raised them.
  const raised: AlertDecision[] = [];
  host.subscribe((s) => {
    const a = s.activeAlert;
    if (a && raised[raised.length - 1]?.id !== a.id) raised.push(a);
  });

  /** Replay raw fixture rows as native emits them: one at a time, only while capturing. */
  async function replay(rows: readonly FeatureRow[]): Promise<number> {
    let emitted = 0;
    for (const raw of rows) {
      clock = Math.max(clock, raw.ts + 200);
      judging = parseRow(raw);
      fake.loadTrace([raw]);
      if (fake.step()) emitted += 1;
      await host.settled();
      await real.settled(); // a tile reply lands between rows, as the network would
    }
    judging = null;
    return emitted;
  }

  /** One manual mounted drive over `rows`, ended from the stopped panel. */
  async function drive(rows: readonly FeatureRow[]) {
    const before = batches.length;
    await host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await host.settled();
    const id = host.snapshot().clientTripId as string;
    const start = lookups.length;
    const emitted = await replay(rows);
    const mid = host.snapshot();
    await host.end();
    await host.untilIdle();
    await host.settled();
    await real.settled();
    return { id, emitted, mid, lookups: lookups.slice(start), batches: batches.slice(before) };
  }

  return {
    host,
    fake,
    drive,
    batches,
    delivered,
    raised,
    traces,
    errors,
    player,
    setClock: (t: number) => {
      clock = t;
    },
    now: () => clock,
  };
}

// --- helpers --------------------------------------------------------------------------------------

const POSTED_35 = { limitMps: mphToMps(35), source: 'posted', matchConfidence: 0.95, parallelRoads: false };
const shift = (rows: readonly FeatureRow[], ms: number): FeatureRow[] => rows.map((r) => ({ ...r, ts: r.ts + ms }));
const known = (s: LimitSample | null): boolean => s !== null && s.source !== 'unknown' && s.limitMps !== null;
const haversineKm = (rows: readonly FeatureRow[]): number => {
  let m = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const k = Math.cos((a.lat * Math.PI) / 180) * M_PER_DEG;
    m += Math.hypot((b.lng - a.lng) * k, (b.lat - a.lat) * M_PER_DEG);
  }
  return m / 1000;
};

async function queued(id: string): Promise<{ payload: FinalizeTripPayload; raw: string }> {
  const { rows } = await db.execute('SELECT kind, payload_json, status FROM sync_queue WHERE idempotency_key = ?', [
    finalizeIdempotencyKey(id),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'finalize-trip', status: 'pending' });
  const raw = rows[0]!.payload_json as string;
  return { payload: FinalizeTripPayloadSchema.parse(JSON.parse(raw)), raw };
}

/** The server re-scores the upload from its own fields (finalize-trip); the device's number must survive that. */
function rescore(p: FinalizeTripPayload) {
  return scoring.scoreTrip(
    {
      distanceM: p.distanceM,
      durationS: p.durationS,
      validGnssPct: p.rowsDigest.validGnssPct,
      imuPresent: p.rowsDigest.imuPresent,
      role: p.role === 'unknown' ? 'unknown' : p.role,
      maxSustainedSpeedMps: p.rowsDigest.maxSustainedSpeedMps,
    },
    p.events.map((e) => ({
      id: e.id,
      category: e.category,
      startedAt: e.startedAt,
      durationS: e.durationS,
      q: e.q,
      corrected: e.corrected,
      status: e.status,
      measured: e.measured,
      context: e.context,
      source: e.source,
    }))
  );
}

// --- the golden -----------------------------------------------------------------------------------

describe('the seed fixture copy', () => {
  test('matches supabase/seed.sql road for road, coordinate for coordinate', () => {
    const sql = readFileSync(join(__dirname, '../../../supabase/seed.sql'), 'utf8');
    const parsed = parseSeedSql(sql);
    expect(parsed).toHaveLength(SEED.length);
    expect(parsed).toEqual(SEED.map((r) => ({ ...r, coords: r.coords.map((c) => [...c]) })));
  });

  test('the corridor tiles hold what B1 measured on the real function', () => {
    const ids = (key: string) => segmentsFor(key).map((s) => s.id).sort();
    expect(ids('15/5249/11443')).toEqual(['9000000001', '9000000002']);
    expect(ids('15/5250/11443')).toEqual(['9000000001', '9000000002', '9000000004', '9000000101']);
    expect(ids('15/5251/11443')).toEqual(['9000000001', '9000000002', '9000000003']);
    // The corridor is 4.1 m north of the row edge, so the 30 m buffer puts it in row 11444 as well
    // (B1 asserts the corridor there). The parallel, 24.1 m north of the edge, is inside it too.
    expect(ids('15/5249/11444')).toEqual(['9000000001', '9000000002']);
    // Every segment is one the device accepts.
    for (const key of [...CORRIDOR_TILES, '15/5249/11444']) {
      expect(() =>
        TileBatchResponseSchema.parse({ tiles: [{ tile: key, expiresAt: MAX_TILE_TTL_MS, truncated: false, segments: segmentsFor(key) }], fallback: null })
      ).not.toThrow();
    }
  });

  test('the speeding trace crosses exactly the corridor three tiles', () => {
    const tiles = new Set(speedingTrace.rows.map((r) => tileKey(tileFor(r.lat, r.lng))));
    expect([...tiles].sort()).toEqual([...CORRIDOR_TILES]);
  });
});


describe('the M3 golden: native events to the queued upload, with real speed limits', () => {
  const { CONSTANTS } = scoring;
  const speedingRaw = speedingTrace.rows as FeatureRow[];
  const phoneRaw = shift(phoneTrace.rows as FeatureRow[], HOUR);

  test('two drives, speeding then phone, from the fake bridge to the queue', async () => {
    const h = harness();
    await h.host.start();
    const one = await h.drive(speedingRaw);
    h.setClock(phoneRaw[0]!.ts - 5_000);
    const two = await h.drive(phoneRaw);
    expect(h.errors).toEqual([]);
    expect(one.emitted).toBe(speedingRaw.length);
    expect(two.emitted).toBe(phoneRaw.length);

    const trips = createTripsRepo(db);
    const eventsRepo = createEventsRepo(db);

    // --- the limit: 35 mph posted on the corridor, from the tiles, along the whole trace ---------
    for (const t of [one, two]) {
      expect(t.mid.status).toBe('recording');
      expect(t.mid.limit).toEqual(POSTED_35);
      // Every answer the engine got was the corridor's 35 mph, or nothing yet (the first row, before
      // the trip-start batch or the SQLite load has landed). Never the parallel's 25, never unknown.
      for (const l of t.lookups) {
        if (l.sample !== null) expect(l.sample).toEqual(POSTED_35);
      }
      // One lookup per row: the judged row's own fix.
      expect(new Set(t.lookups.map((l) => l.ts)).size).toBe(150);
    }

    // Coverage along the trace, tile by tile (rev1: I6), not merely above zero.
    for (const tile of CORRIDOR_TILES) {
      const inTile = one.lookups.filter((l) => l.tile === tile);
      expect(inTile.length).toBeGreaterThanOrEqual(20);
      expect(inTile.filter((l) => known(l.sample)).length / inTile.length).toBeGreaterThanOrEqual(0.9);
    }
    const coverage = (lookups: Lookup[]) => (lookups.filter((l) => known(l.sample)).length * 100) / lookups.length;
    expect(coverage(one.lookups)).toBeGreaterThanOrEqual(90);
    expect(coverage(two.lookups)).toBeGreaterThanOrEqual(90);

    // --- the network: the start batch, then at most one batch per km; the second drive is cached --
    const km = haversineKm(speedingRaw.map((r) => parseRow(r)!));
    expect(km).toBeGreaterThan(2);
    expect(one.batches.length).toBeLessThanOrEqual(1 + Math.floor(km));
    expect(one.batches.map((b) => b.keys)).toEqual([
      ['15/5249/11443', '15/5250/11443', '15/5249/11444', '15/5250/11444'],
      ['15/5251/11443', '15/5251/11444'],
      ['15/5252/11443', '15/5252/11444'],
    ]);
    expect(one.batches[0]!.at).toBeLessThanOrEqual(speedingRaw[0]!.ts + 1_000); // at the first fix
    expect(two.batches).toEqual([]); // every tile it needs is fresh in SQLite

    // --- drive one: the speeding episode, scored against the posted limit, with correction credit --
    const tripOne = (await trips.get(one.id)) as TripRow;
    const eventsOne = await eventsRepo.listByTrip(one.id);
    expect(eventsOne.map((e) => e.category)).toEqual(['speeding']);
    const speeding = eventsOne[0]!;
    const want = speedingTrace.expected[0]!;
    expect(speeding.status).toBe('scored');
    expect(Math.abs(speeding.started_at - want.startsNear)).toBeLessThanOrEqual(2_000);
    expect(speeding.duration_s).toBeGreaterThanOrEqual(want.durationMin!);
    expect(speeding.duration_s).toBeLessThanOrEqual(want.durationMax!);
    expect(speeding.confidence).toBeGreaterThanOrEqual(want.qMin!);
    expect(JSON.parse(speeding.measured_json!)).toMatchObject({ limitMps: mphToMps(35) });
    expect(speeding.alert_shown).toBe(1);
    expect(speeding.corrected).toBe(1);
    // Scored with source posted: every row of the episode was judged against the posted limit, at
    // a confidence the alert and scoring gate accepts.
    const episode = one.lookups.filter(
      (l) => l.ts >= speeding.started_at && l.ts < speeding.started_at + speeding.duration_s * 1000
    );
    expect(episode.length).toBeGreaterThanOrEqual(want.durationMin!);
    for (const l of episode) {
      expect(l.sample).toMatchObject({ source: 'posted', limitMps: mphToMps(35) });
      expect(l.sample!.matchConfidence).toBeGreaterThanOrEqual(CONSTANTS.Q_FULL_AT);
    }

    // --- drive two: the phone event; the corridor's real 35 mph makes no speeding of 15.7 m/s -----
    const tripTwo = (await trips.get(two.id)) as TripRow;
    const eventsTwo = await eventsRepo.listByTrip(two.id);
    expect(eventsTwo.map((e) => e.category)).toEqual(['phone']);
    const phone = eventsTwo[0]!;
    const wantPhone = phoneTrace.expected[0]!;
    expect(phone.status).toBe('scored');
    expect(Math.abs(phone.started_at - (wantPhone.startsNear + HOUR))).toBeLessThanOrEqual(2_000);
    expect(phone.duration_s).toBe(wantPhone.durationMin);
    expect(phone.confidence).toBeGreaterThanOrEqual(wantPhone.qMin!);
    expect(phone.alert_shown).toBe(1);
    expect(two.mid.tripIndex).toBe(1); // the first drive counts toward the learning period

    // --- the alerts: L1 (learning period), handed to the player in the order they were decided ----
    expect(h.delivered.map((d) => [d.kind, d.level, d.ts, d.eventId])).toEqual([
      ['speeding', 1, speedingRaw[0]!.ts + 39_000, speeding.id],
      ['speeding', 1, speedingRaw[0]!.ts + 69_000, speeding.id],
      ['phone', 1, phoneRaw[0]!.ts + 62_000, phone.id],
    ]);
    expect(h.delivered).toEqual(h.raised);
    expect(h.player.deliver.mock.calls.map(([d]) => d)).toEqual(h.raised);
    // The first L1 came once the speeding had lasted its minimum; the credit is for ending the
    // episode inside the grace window after the last one.
    const speedingEnd = speeding.started_at + speeding.duration_s * 1000;
    expect(h.delivered[0]!.ts - speeding.started_at).toBeGreaterThanOrEqual(CONSTANTS.ALERT_L1_SPEEDING_MIN_S * 1000);
    expect(speedingEnd - h.delivered[1]!.ts).toBeLessThanOrEqual(CONSTANTS.SPEEDING_GRACE_S * 1000);

    // --- the stored trips and their queued uploads ------------------------------------------------
    for (const [t, row, raw] of [
      [one, tripOne, speedingRaw],
      [two, tripTwo, phoneRaw],
    ] as const) {
      const { payload } = await queued(t.id);
      expect(row).toMatchObject({ status: 'provisional', sync_state: 'queued', role: 'driver', role_source: 'manual' });
      expect(payload).toMatchObject({ clientTripId: t.id, role: 'driver', roleSource: 'manual', mode: 'mounted', tz: TZ });
      expect(payload.provisional.status).toBe('final');
      expect(row.score).toBe(payload.provisional.score);
      // What finalize-trip computes from the upload's own fields is what the device showed.
      expect(rescore(payload)).toEqual(payload.provisional);
      expect(row.limit_coverage_pct).toBe(payload.limitCoveragePct);
      expect(payload.limitCoveragePct).toBeGreaterThanOrEqual(90);
      expect(payload.limitCoveragePct).toBeCloseTo(coverage(t.lookups), 10);

      // The trace and the digest describe the rows as parseRow rounded them (D2).
      const rows = raw.map((r) => parseRow(r)!);
      const text = canonicalJson(rows);
      expect(text).not.toBe(canonicalJson(raw)); // the rounding is real on these fixtures
      expect(payload.tracePath).toBe(tracePathFor(t.id));
      const file = h.traces.get(tracePathFor(t.id))!;
      expect(new TextDecoder().decode(gunzipSync(file))).toBe(text);
      expect(file.length / text.length).toBeLessThan(0.25);
      expect(payload.rowsDigest).toMatchObject({ count: rows.length, validGnssPct: 100, sha256: await sha256(text) });
    }
    const [p1, p2] = [(await queued(one.id)).payload, (await queued(two.id)).payload];
    expect(p1.events.find((e) => e.category === 'speeding')).toMatchObject({ corrected: true, alertShown: true, status: 'scored' });
    expect(p2.events.find((e) => e.category === 'phone')).toMatchObject({ alertShown: true, status: 'scored' });
    // The pinned outcome of this golden: a change anywhere on the path shows up here.
    expect([tripOne.score, tripTwo.score]).toEqual([97, 86]);
    expect(p1.provisional.categoryDeductions.speeding).toBeGreaterThan(0);
    expect(p2.provisional.categoryDeductions.phone).toBeGreaterThan(0);
    expect(h.host.snapshot()).toMatchObject({ status: 'off', lastFinalized: { clientTripId: two.id, ok: true } });
  });
});
