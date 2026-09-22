/** @jest-environment node */
import { createArbiter } from '@/core/alerts/arbiter';
import { createDetectors } from '@/core/detectors';
import { T0, counterIds, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { TripSession } from '@/core/engine/engine.types';
import { NO_FIX_END_S, createEngine } from '@/core/engine/machine';
import { runTrace } from '@/core/replay/runTrace';
import {
  GARAGE_ROW,
  MPH,
  ROW_DEFAULTS,
  T0 as SYNTH_T0,
  TRACE_BUILDERS,
  serializeTrace,
} from '@/core/replay/synth';
import { limitAt, parseTrace } from '@/core/replay/trace';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
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

test('the traces of the M1 and M3 briefs are on disk, one builder each', () => {
  expect(names).toEqual([
    'clean-commute',
    'garage-no-fix',
    'hard-brake-agreeing',
    'mounted-app-switch',
    'mounted-locked',
    'phone-pickup',
    'phone-slide-false-positive',
    'pocket-open-moving',
    'speeding-corrected',
    'stopped-phone-use',
  ]);
  expect(Object.keys(TRACE_BUILDERS).sort()).toEqual(names);
});

test.each(names)('%s replays to the events it expects', (name) => {
  const result = runTrace(load(name));
  expect(result.failures).toEqual([]);
  expect(result.passes).toBe(true);
});

test.each(names)('%s on disk is exactly what the generator writes', (name) => {
  // `npm run traces:make` regenerates these files from the same builders; if this fails, either
  // the fixture was hand-edited or the generator changed and the fixtures were not regenerated.
  expect(text(name)).toBe(serializeTrace(TRACE_BUILDERS[name]!()));
});

test.each(names)('%s is a named 1 Hz drive of at least 120 rows that asserts something', (name) => {
  const trace = load(name);
  expect(trace.name).toBe(name);
  expect(trace.rows.length).toBeGreaterThanOrEqual(120);
  expect(trace.expected.length).toBeGreaterThan(0);
  const gaps = new Set(trace.rows.slice(1).map((r, i) => r.ts - trace.rows[i]!.ts));
  expect([...gaps]).toEqual([1000]);
});

test.each(names)('%s drives a straight line away from Seattle', (name) => {
  const trace = load(name);
  const first = trace.rows[0]!;
  const last = trace.rows[trace.rows.length - 1]!;
  expect(first.lat).toBeCloseTo(47.6062, 4);
  expect(new Set(trace.rows.map((r) => r.lat)).size).toBe(1);
  expect(last.lng).toBeGreaterThan(first.lng);
  // Every fix is a plausible car speed; a row without one carries the -1 sentinel.
  expect(trace.rows.every((r) => (r.gnssValid ? r.speed >= 0 && r.speed < 40 : r.speed === -1))).toBe(
    true
  );
});

test('the synthetic rows carry the same sensor defaults as the detector fixtures', () => {
  // The traces are only a regression suite if a quiet second looks exactly like the quiet second
  // the detector unit tests use. `synth.ts` cannot import any of this — plain Node has to be able
  // to require it — so the duplicated values are pinned here instead.
  const quiet = row();
  const shared = Object.fromEntries(
    Object.keys(ROW_DEFAULTS).map((k) => [k, quiet[k as keyof typeof quiet]])
  );
  expect(ROW_DEFAULTS).toEqual(shared);
  expect(SYNTH_T0).toBe(T0);
  expect(MPH).toBe(mph(1));
});

// --- M3 (E1): the phone-use fixes and the no-fix end, on the fixtures ---------------------------

describe('M3 traces', () => {
  test('pocket-open-moving: exactly one phone event, q 0.9 from the OS; mounted, the same rows are nothing', () => {
    const trace = load('pocket-open-moving');
    const pocket = runTrace(trace);
    expect(pocket.events).toHaveLength(1);
    expect(pocket.events[0]).toMatchObject({ category: 'phone', q: 0.9, source: 'os', status: 'scored' });
    expect(runTrace({ ...trace, mode: 'mounted' }).events).toEqual([]);
  });

  test.each(['reliable', 'lagged', 'unreliable'] as const)(
    'mounted-locked: a minute locked at speed is no phone event on a %s lock signal',
    (lockSignal) => {
      expect(runTrace({ ...load('mounted-locked'), lockSignal }).events).toEqual([]);
    }
  );

  test('lagged lock: the 20 s app switch still counts in full; a side-button press that locks within 12 s is dropped', () => {
    const lagged = runTrace({ ...load('mounted-app-switch'), lockSignal: 'lagged' });
    expect(lagged.failures).toEqual([]);
    expect(lagged.events).toEqual([expect.objectContaining({ category: 'phone', durationS: 20, q: 0.9 })]);

    // The same drive, but the "switch" is the side button: backgrounded at once, locked 11 s later.
    const pressed = load('mounted-locked');
    const rows = pressed.rows.map((r, i) =>
      i >= 40 && i < 51 ? { ...r, locked: false, screenOn: true } : r
    );
    expect(runTrace({ ...pressed, rows, lockSignal: 'lagged' }).events).toEqual([]);
    // With a reliable signal those eleven unlocked, backgrounded seconds are an app switch.
    expect(runTrace({ ...pressed, rows }).events).toEqual([
      expect.objectContaining({ category: 'phone', durationS: 11 }),
    ]);
  });

  test('garage-no-fix: replayed through the engine, the trip goes to ending ten minutes into the fix-less stillness', async () => {
    const trace = load('garage-no-fix');
    const finalized: Readonly<TripSession>[] = [];
    const engine = createEngine({
      now: () => 0,
      newId: () => 'garage',
      limits: { lookup: () => limitAt(trace.limits, 0), prefetch: () => {} },
      createDetectors: () => createDetectors(counterIds()),
      createArbiter: () => createArbiter({ tripIndex: 10 }),
      onAlert: () => {},
      onCheckpoint: async () => {},
      onFinalize: async (s) => {
        finalized.push(s);
      },
      ctx: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
    });
    const first = trace.rows[0]!;
    await engine.dispatch({ type: 'manualStart', mode: trace.mode, passenger: false, ts: first.ts });
    const statuses: string[] = [];
    for (const r of trace.rows) {
      await engine.dispatch({ type: 'row', row: r });
      statuses.push(engine.snapshot().status);
    }
    const endsOn = GARAGE_ROW + NO_FIX_END_S - 1;
    expect(statuses.lastIndexOf('recording')).toBe(endsOn - 1);
    expect(statuses[endsOn]).toBe('ending');
    await engine.dispatch({ type: 'end', ts: trace.rows[trace.rows.length - 1]!.ts + 1000 });
    expect(finalized).toHaveLength(1);
    // Driving stopped where the fix went, not at the end of the eleven minutes.
    expect(finalized[0]).toMatchObject({ endedAt: trace.rows[GARAGE_ROW]!.ts, durationS: GARAGE_ROW });
    expect(finalized[0]!.events).toEqual([]);
  });
});
