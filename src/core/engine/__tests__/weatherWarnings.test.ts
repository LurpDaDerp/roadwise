/** @jest-environment node */
// Weather warnings (the weather "Slow down" and the alert-only hard brake, start and turn warnings):
// they warn sooner on a wet, snowy or icy road or in fog, and never change a point. The golden test
// drives the same rows with and without a road state and asks for the same drive, to the payload.
import { speedingRepeatS } from '@/core/alerts/policy';
import { createDetectors } from '@/core/detectors';
import { limit, mph, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { AlertEvent, EngineDeps, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { finalizeTrip } from '@/core/engine/finalize';
import { createEngine } from '@/core/engine/machine';
import type { FeatureRow } from '@/core/engine/types';
import type { RoadStamp } from '@/core/road';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate } from '@/data/db';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Harness {
  engine: ReturnType<typeof createEngine>;
  alerts: AlertEvent[];
  finalized: Readonly<TripSession>[];
  snapshots: EngineSnapshot[];
}

function harness(limitMph = 35, over: Partial<EngineDeps> = {}): Harness {
  let n = 0;
  const h = { alerts: [], finalized: [], snapshots: [] } as unknown as Harness;
  h.engine = createEngine({
    now: () => T0,
    newId: () => uuid((n += 1)),
    limits: { lookup: () => limit(mph(limitMph)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => uuid((n += 1))),
    ctx: () => ({ platform: 'ios' }),
    onAlert: (a) => h.alerts.push(a),
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      h.finalized.push(s);
    },
    onCancel: async () => {},
    ...over,
  });
  h.engine.subscribe((s) => h.snapshots.push(s));
  return h;
}

async function started(limitMph = 35): Promise<Harness> {
  const h = harness(limitMph);
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  return h;
}

const feed = async (h: Harness, rows: FeatureRow[], replay = false) => {
  for (const r of rows) await h.engine.dispatch({ type: 'row', row: r, ...(replay ? { replay: true } : {}) });
};

/** Rows from `fromS` s after the warm-up (T0 + 31 s), the forward axis learned (a whisper of forward force on every row). */
const at = (fromS: number, n: number, o: Partial<FeatureRow>) =>
  seq([n, (i) => ({ aLonMax: 0.02, aLonMin: -0.02, ...o, ts: T0 + 31_000 + (fromS + i) * 1000 })]);
const rowOf = (a: AlertEvent) => (a.at - T0 - 31_000) / 1000;
const shown = (h: Harness) => h.alerts.filter((a) => a.repeat !== true);
const wet: RoadStamp = { g: 'wet' };

describe('the weather "Slow down": warns at the weather line, never an event', () => {
  test('38 on a wet 35 (the weather line 35.74; speeding’s 39.8): one minor alert naming the road, a minor shake, the band held; repeats on speeding’s cadence; no event', async () => {
    const h = await started();
    await feed(h, [...at(0, 3, { speed: mph(33), road: wet }), ...at(3, 20, { speed: mph(38), road: wet })]);
    expect(shown(h)).toEqual([{ id: `wx-speeding-${T0 + 34_000}`, type: 'speeding', tier: 'minor', at: T0 + 34_000, road: 'wet' }]);
    const s = h.engine.snapshot();
    expect(s).toMatchObject({ speedingWeather: 'wet', speedingTier: null, speedingOver: true, lastAlert: shown(h)[0] });
    expect(s.lastShake).toEqual({ key: `wx-speeding-${T0 + 34_000}`, at: T0 + 34_000, tier: 'minor' });
    // 2.26 past the weather line: 8 / 1.45 × 0.85^(elapsed / 10) s, about 5 s apart.
    const repeats = h.alerts.filter((a) => a.repeat === true);
    expect(repeats.length).toBeGreaterThanOrEqual(3);
    for (const r of repeats) expect(r).toMatchObject({ id: `wx-speeding-${T0 + 34_000}`, type: 'speeding', tier: 'minor', repeat: true, road: 'wet' });
    // Speeding's own cadence, counted from the stretch's first over row.
    const due: number[] = [];
    for (let row = 4, last = 3; row < 23; row += 1) {
      if (row - last >= speedingRepeatS(38 - 35.74, row - 3)) due.push((last = row));
    }
    expect(repeats.map(rowOf)).toEqual(due);
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    expect(h.finalized[0]!.events).toEqual([]);
    expect(h.engine.snapshot()).toMatchObject({ speedingWeather: null, speedingOver: false });
  });

  test('past speeding’s line the regular episode alerts as always (no road); back under it, still over the weather line, the band falls back to the weather "Slow down" silently', async () => {
    const h = await started();
    await feed(h, at(0, 3, { speed: mph(38), road: wet }));
    await feed(h, at(3, 3, { speed: mph(44), road: wet }));
    expect(h.engine.snapshot()).toMatchObject({ speedingWeather: null, speedingTier: 'moderate', speedingOver: true });
    await feed(h, at(6, 3, { speed: mph(38), road: wet }));
    expect(h.engine.snapshot()).toMatchObject({ speedingWeather: 'wet', speedingTier: null, speedingOver: true });
    expect(shown(h).map((a) => [rowOf(a), a.type, a.tier, a.road])).toEqual([
      [0, 'speeding', 'minor', 'wet'],
      [3, 'speeding', 'moderate', undefined],
    ]);
    // The regular episode is the event, judged at the posted limit.
    await feed(h, at(9, 10, { speed: mph(30), road: wet }));
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    expect(h.finalized[0]!.events.map((e) => [e.type, e.tier, e.durationS])).toEqual([['speeding', 'moderate', 3]]);
  });

  test('straight past speeding’s line: only the regular alert; the fallback after it is silent', async () => {
    const h = await started();
    await feed(h, [...at(0, 3, { speed: mph(30), road: wet }), ...at(3, 3, { speed: mph(44), road: wet }), ...at(6, 4, { speed: mph(38), road: wet })]);
    expect(shown(h).map((a) => [rowOf(a), a.tier, a.road])).toEqual([[3, 'moderate', undefined]]);
    expect(h.engine.snapshot().speedingWeather).toBe('wet');
  });

  test('once per stretch: hovering in the buffer and back over is no new alert; 5 rows under the line less 2 mph end it', async () => {
    const h = await started();
    await feed(h, [...at(0, 2, { speed: mph(38), road: wet }), ...at(2, 6, { speed: mph(35), road: wet })]);
    expect(h.engine.snapshot()).toMatchObject({ speedingWeather: null, speedingOver: false });
    await feed(h, at(8, 2, { speed: mph(38), road: wet }));
    expect(shown(h)).toHaveLength(1);
    expect(h.engine.snapshot().speedingWeather).toBe('wet');
    await feed(h, [...at(10, 5, { speed: mph(30), road: wet }), ...at(15, 1, { speed: mph(38), road: wet })]);
    expect(shown(h).map(rowOf)).toEqual([0, 15]);
  });

  test('never on unstamped rows, nor with a sight cap at or above the limit', async () => {
    const h = await started();
    await feed(h, [...at(0, 10, { speed: mph(38) }), ...at(10, 10, { speed: mph(38), road: { cap: 45 } })]);
    expect(h.alerts).toEqual([]);
    expect(h.snapshots.every((s) => s.speedingWeather === null && !s.speedingOver)).toBe(true);
  });

  test('fog: low visibility’s cap names the warning when it is the lower limit', async () => {
    const h = await started(65);
    // 65 wet is 58.5; a 45 cap is lower: the line 51.4.
    await feed(h, at(0, 3, { speed: mph(55), road: { g: 'wet', cap: 45 } }));
    expect(shown(h)).toMatchObject([{ type: 'speeding', tier: 'minor', road: 'fog' }]);
    expect(h.engine.snapshot().speedingWeather).toBe('fog');
  });

  test('on the row a scored hard start is confirmed, the weather "Slow down" is told but the hard start stays the one shown and shaken', async () => {
    const h = await started();
    await feed(h, [...at(0, 5, { speed: mph(30), road: wet }), ...at(5, 1, { speed: mph(38), aLonMax: 0.45, road: wet }), ...at(6, 4, { speed: mph(38), road: wet })]);
    const first = shown(h).filter((a) => a.at === T0 + 36_000);
    expect(first.map((a) => [a.type, a.road])).toEqual([
      ['hard_accel', undefined],
      ['speeding', 'wet'],
    ]);
    const start = first[0]!;
    // The band still holds the weather "Slow down".
    expect(h.engine.snapshot()).toMatchObject({
      lastAlert: start,
      lastShake: { key: start.id, at: T0 + 36_000, tier: start.tier },
      speedingWeather: 'wet',
      speedingOver: true,
    });
  });

  test('a replayed row tells the weather alert but never shows or shakes it, like a regular one', async () => {
    const h = await started();
    await feed(h, at(0, 3, { speed: mph(38), road: wet }), true);
    expect(h.alerts[0]).toMatchObject({ type: 'speeding', road: 'wet' });
    expect(h.snapshots.every((s) => s.lastAlert === null && s.lastShake === null)).toBe(true);
  });
});

describe('weather hard brake, start and turn warnings', () => {
  /** A brake of `g` from 35 to 25 mph, then cruising. */
  const brake = (g: number, road?: RoadStamp) =>
    [...at(0, 5, { speed: mph(35), road }), ...at(5, 1, { speed: mph(25), aLonMin: -g, road }), ...at(6, 6, { speed: mph(25), road })];

  test('a 0.33 g brake on a wet road: a minor warning naming the road, shown and shaken; no event', async () => {
    const h = await started();
    await feed(h, brake(0.33, wet));
    const id = `wx-hard_brake-${T0 + 36_000}`;
    expect(shown(h)).toEqual([{ id, type: 'hard_brake', tier: 'minor', at: T0 + 36_000, road: 'wet' }]);
    expect(h.engine.snapshot()).toMatchObject({ lastAlert: { id, road: 'wet' }, lastShake: { key: id, at: T0 + 36_000, tier: 'minor' } });
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    expect(h.finalized[0]!.events).toEqual([]);
  });

  test('a 0.40 g brake on a wet road: the regular alert only (past the dry line), and its event', async () => {
    const h = await started();
    await feed(h, brake(0.4, wet));
    expect(shown(h)).toEqual([{ id: expect.any(String), type: 'hard_brake', tier: 'minor', at: T0 + 36_000 }]);
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    expect(h.finalized[0]!.events.map((e) => e.type)).toEqual(['hard_brake']);
  });

  test('never on unstamped rows or for a sight cap alone', async () => {
    for (const road of [undefined, { cap: 35 } as RoadStamp]) {
      const h = await started();
      await feed(h, brake(0.33, road));
      expect(h.alerts).toEqual([]);
    }
  });

  test('snow and ice name themselves; a 0.33 g start on snow warns (the 0.32 line)', async () => {
    const h = await started();
    await feed(h, [...at(0, 5, { speed: mph(20), road: { g: 'snow' } }), ...at(5, 1, { speed: mph(28), aLonMax: 0.33, road: { g: 'snow' } }), ...at(6, 6, { speed: mph(28), road: { g: 'snow' } })]);
    expect(shown(h)).toMatchObject([{ type: 'hard_accel', tier: 'minor', road: 'snow' }]);
    const i = await started();
    await feed(i, brake(0.3, { g: 'ice' }));
    // 35 on an icy 35 is over its weather line (24.5 judged) too.
    expect(shown(i).filter((x) => x.type === 'hard_brake')).toMatchObject([{ tier: 'minor', road: 'ice' }]);
  });
});

// --- the golden property ----------------------------------------------------------------------

/** A drive with every case in it, its speeds scaled to the posted limit `L`. */
function goldenDrive(L: number, between: number[]): FeatureRow[] {
  const segs: [number, Partial<FeatureRow>][] = [];
  const add = (n: number, o: Partial<FeatureRow>) => segs.push([n, o]);
  const cruise = L - 5;
  // Before the forward axis is learned: a sharp GNSS slowdown (about 0.34 g) stands in for a brake.
  add(40, { speed: mph(cruise) });
  add(6, { speed: mph(cruise - 7.5) });
  add(6, { speed: mph(cruise) });
  const steady = { aLonMax: 0.02, aLonMin: -0.02 };
  // Speeding between the weather lines and speeding's line, past speeding's, then back between.
  for (const v of between) add(12, { speed: mph(v), ...steady });
  add(8, { speed: mph(L + 0.16 * L + 5), ...steady });
  add(6, { speed: mph(between[0]!), ...steady });
  add(10, { speed: mph(cruise), ...steady });
  // Brakes, starts and turns between the weather and dry lines, and past the dry ones.
  for (const g of [0.3, 0.33, 0.35, 0.4, 0.58]) {
    add(1, { speed: mph(cruise - 10), aLonMax: 0.02, aLonMin: -g });
    add(8, { speed: mph(cruise - 10), ...steady });
    add(8, { speed: mph(cruise), ...steady });
  }
  for (const g of [0.33, 0.38, 0.45, 0.62]) {
    add(1, { speed: mph(cruise + 8), aLonMax: g, aLonMin: -0.02 });
    add(8, { speed: mph(cruise + 8), ...steady });
    add(8, { speed: mph(cruise), ...steady });
  }
  let course = 90;
  for (const g of [0.4, 0.45, 0.5, 0.75]) {
    course = (course + 30) % 360;
    add(1, { speed: mph(30), course, yawRateMax: 3, aLatMin: -g, ...steady });
    add(8, { speed: mph(30), course, ...steady });
  }
  add(10, { speed: mph(cruise), course, ...steady });
  const rows = seq(...segs.map(([n, o]) => [n, o] as const));
  // Moving along: about 11 m a second.
  return rows.map((r, i) => ({ ...r, lat: 47.6 + i * 0.0001 }));
}

const stripRoad = <T,>(v: T): T => JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === 'road' ? undefined : x))) as T;

async function driveOf(L: number, rows: FeatureRow[]) {
  const h = harness(L);
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  await feed(h, rows);
  await h.engine.dispatch({ type: 'end', ts: rows[rows.length - 1]!.ts + 1000 });
  const session = h.finalized[0]!;
  const db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
  const result = await finalizeTrip(session, { db, tz: 'America/Los_Angeles', now: () => T0 + 10_000_000, appVersion: '2.0.0', geocode: null, trimSeed: async (id: string) => `${id}-seed`.padEnd(64, '0') });
  return { h, session, result };
}

describe('golden: the same rows with and without a road state are the same drive, to the payload', () => {
  test.each<[string, number, number[], RoadStamp]>([
    ['wet', 35, [37, 38.5], { g: 'wet' }],
    ['heavy rain', 35, [36, 38.5], { g: 'water' }],
    ['snow', 35, [33, 38.5], { g: 'snow' }],
    ['ice', 35, [30, 38.5], { g: 'ice' }],
    ['ice in fog', 35, [30, 38.5], { g: 'ice', cap: 35 }],
    ['fog on a 65', 65, [48, 60, 72], { cap: 45 }],
    ['wet in fog on a 65', 65, [48, 60, 72], { g: 'wet', cap: 55 }],
    ['snow on a 65', 65, [56, 60, 72], { g: 'snow', cap: 65 }],
  ])('%s', async (_name, L, between, road) => {
    const rows = goldenDrive(L, between);
    const dry = await driveOf(L, rows);
    const stamped = await driveOf(L, rows.map((r) => ({ ...r, road })));

    // The drive has something in it, and the weather warned where the dry lines did not.
    expect(dry.session.events.length).toBeGreaterThan(3);
    expect(stamped.h.alerts.some((a) => a.road !== undefined)).toBe(true);
    expect(dry.h.alerts.some((a) => a.road !== undefined)).toBe(false);

    expect(stamped.session.events).toEqual(dry.session.events);
    expect(stripRoad(stamped.session)).toEqual(stripRoad(dry.session));
    expect(stamped.result.payload).not.toBeNull();
    expect(stamped.result.payload).toEqual(dry.result.payload);
    expect(stamped.result.trip).toEqual(dry.result.trip);
    expect(stamped.result.events).toEqual(dry.result.events);
    expect(stamped.result.drive).toEqual(dry.result.drive);
    // The regular alerts are the same alerts.
    expect(stamped.h.alerts.filter((a) => a.road === undefined)).toEqual(dry.h.alerts);
  });
});
