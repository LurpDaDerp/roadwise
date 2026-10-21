/** @jest-environment node */
import { createDetectors } from '@/core/detectors';
import type { TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import { rebuildFromSamples } from '@/core/engine/replay';
import type { LimitSample } from '@/core/engine/types';
import { runTrace } from '@/core/replay/runTrace';
import { TRACE_BUILDERS, serializeTrace } from '@/core/replay/synth';
import { limitAt, parseTrace, type Trace } from '@/core/replay/trace';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSamplesRepo, createTripsRepo, migrate } from '@/data/db';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
const { readdirSync, readFileSync } = require('node:fs') as {
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const DIR = join(__dirname, '..', '..', '__fixtures__', 'traces');
const names = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
const text = (name: string): string => readFileSync(join(DIR, `${name}.json`), 'utf8');
const load = (name: string) => parseTrace(JSON.parse(text(name)));

test('every builder has a fixture on disk and vice versa', () => {
  expect(names).toEqual(Object.keys(TRACE_BUILDERS).sort());
  expect(names.length).toBeGreaterThanOrEqual(20);
});

test.each(names)('%s replays to the events it expects', (name) => {
  const result = runTrace(load(name));
  expect(result.failures).toEqual([]);
  expect(result.passes).toBe(true);
});

test.each(names)('%s on disk is exactly what the generator writes', (name) => {
  expect(text(name)).toBe(serializeTrace(TRACE_BUILDERS[name]!()));
});

test.each(names)('%s is a 1 Hz drive that asserts something', (name) => {
  const trace = load(name);
  expect(trace.name).toBe(name);
  expect(trace.rows.length).toBeGreaterThanOrEqual(120);
  expect(trace.expected.length).toBeGreaterThan(0);
  const gaps = new Set(trace.rows.slice(1).map((r, i) => r.ts - trace.rows[i]!.ts));
  expect([...gaps]).toEqual([1000]);
});

/**
 * Each trace's opportunity counters (slowdowns, speed-ups, turns, limit seconds, moving seconds,
 * phone seconds), with the harness's 30 s warm-up. The synthetic drives run straight east, so only
 * `turn-right-90` turns; a 35 → 25 mph brake is a 10 mph drop, under the 12 mph slowdown line. Phone
 * seconds are every row at 10 mph or more on a trusted speed on which a pickup could be seen (the
 * motion sensors read; on iPhone no call: `phone-hands-free-call` loses its 20 call rows, Android's
 * `phone-call-android` keeps them), the warm-up's included.
 */
const EXPOSURE: Record<string, readonly [number, number, number, number, number, number]> = {
  'clean-commute': [0, 0, 0, 270, 300, 300],
  'hard-accel-confirmed': [0, 0, 0, 170, 200, 200],
  'hard-brake-confirmed': [0, 0, 0, 170, 200, 200],
  'hard-brake-poor-speedacc': [0, 0, 0, 168, 200, 198],
  'hard-brake-severe': [1, 0, 0, 170, 200, 200],
  'hard-brake-unconfirmed': [0, 0, 0, 170, 200, 200],
  'hard-corner-no-course': [0, 0, 0, 170, 200, 200],
  'hard-corner-plausible': [0, 0, 0, 170, 200, 200],
  'hard-corner-straight': [0, 0, 0, 170, 200, 200],
  'hard-corner-wrong-side': [0, 0, 0, 170, 200, 200],
  'phone-call-android': [0, 0, 0, 170, 200, 200],
  'phone-handling-long': [0, 0, 0, 210, 240, 240],
  'phone-hands-free-call': [0, 0, 0, 170, 200, 180],
  'phone-parked-start': [0, 1, 0, 120, 120, 120],
  'phone-pickup': [0, 0, 0, 170, 200, 200],
  'phone-red-light-drive-off': [1, 1, 0, 180, 210, 210],
  'phone-slide-false-positive': [0, 0, 0, 170, 200, 200],
  'phone-stopped-in-traffic': [1, 1, 0, 170, 200, 200],
  'phone-tap-mounted': [0, 0, 0, 170, 200, 200],
  'speeding-blip': [0, 0, 0, 170, 200, 200],
  'speeding-blip-hover': [0, 0, 0, 170, 200, 200],
  'speeding-grace': [1, 1, 0, 170, 200, 200],
  'speeding-hover': [0, 0, 0, 210, 240, 240],
  'speeding-minor': [0, 0, 0, 210, 240, 240],
  'speeding-poor-gps': [1, 1, 0, 130, 200, 200],
  'speeding-poor-speedacc': [0, 0, 0, 190, 240, 220],
  'speeding-severe-brief': [1, 1, 0, 170, 200, 200],
  'speeding-split': [0, 0, 0, 170, 200, 200],
  'speeding-unknown-limit': [1, 1, 0, 120, 200, 200],
  'speeding-warmup': [1, 0, 0, 170, 200, 200],
  'stop-and-go': [3, 3, 0, 139, 181, 169],
  'turn-right-90': [0, 0, 1, 170, 200, 200],
};

test('every trace pins its opportunity counters', () => {
  expect(Object.keys(EXPOSURE).sort()).toEqual(names);
});

test.each(names)('%s counts its slowdowns, speed-ups, turns, limit time, moving time and phone time', (name) => {
  const e = runTrace(load(name)).exposure;
  expect([e.slowdowns, e.speedups, e.turns, e.limitS, e.movingS, e.phoneS]).toEqual(EXPOSURE[name]);
});

/** The trace's limits looked up by position, as the tiles answer the engine (the first row at a spot decides). */
function limitsByPlace(trace: Trace): { lookup: (lat: number, lng: number) => LimitSample } {
  const at = new Map<string, LimitSample>();
  for (const r of trace.rows) if (!at.has(`${r.lat},${r.lng}`)) at.set(`${r.lat},${r.lng}`, limitAt(trace.limits, r.ts));
  return { lookup: (lat, lng) => at.get(`${lat},${lng}`)! };
}

test.each(names)('%s gives the same counters live and rebuilt from its stored rows', async (name) => {
  const trace = load(name);
  const t0 = trace.rows[0]!.ts;
  const limits = limitsByPlace(trace);
  const engine = createEngine({
    now: () => t0,
    newId: () => 'live',
    limits: { lookup: (lat, lng) => limits.lookup(lat, lng), prefetch: () => {} },
    createDetectors: () => createDetectors(() => 'x'),
    ctx: () => ({ platform: trace.platform ?? 'ios' }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async () => {},
    onCancel: async () => {},
  });
  await engine.dispatch({ type: 'start', ts: t0, origin: 'manual', continues: false });
  for (const row of trace.rows) await engine.dispatch({ type: 'row', row });
  const live = engine.session() as Readonly<TripSession>;

  const db = await createSqlJsDb();
  await migrate(db);
  await createTripsRepo(db).insert({ client_trip_id: 'live', started_at: t0, tz: 'America/Los_Angeles', status: 'recording', origin: 'manual' }, t0);
  await createSamplesRepo(db).appendMany('live', trace.rows.map((row) => ({ ts: row.ts, row })));
  const trip = (await createTripsRepo(db).get('live'))!;
  const rebuilt = (await rebuildFromSamples(db, trip, {
    createDetectors: () => createDetectors(() => 'x'),
    platform: trace.platform ?? 'ios',
    limits: { lookup: async (lat, lng) => limits.lookup(lat, lng) },
  }))!.session;
  expect(rebuilt.exposure).toEqual(live.exposure);
  expect(rebuilt.movingRows).toBe(live.movingRows);
  // The events too: a phone pickup rebuilt from the stored rows is the one the live drive had.
  expect(rebuilt.events.map((e) => [e.type, e.startedAt, e.durationS, e.tier])).toEqual(live.events.map((e) => [e.type, e.startedAt, e.durationS, e.tier]));
});

test('parseTrace refuses an unknown key and a bad expectation', () => {
  const ok = TRACE_BUILDERS['clean-commute']!();
  expect(() => parseTrace({ ...ok, bogus: 1 })).toThrow(/Invalid trace/);
  expect(() => parseTrace({ ...ok, expected: [{ type: 'speeding', startsNear: 1, status: 'scored' }] })).toThrow(/Invalid trace/);
});
