import { T0, mph, row, seq } from '@/core/detectors/__fixtures__/rows';
import type { FeatureRow } from '@/core/engine/types';
import { runTrace } from '@/core/replay/runTrace';
import type { Expectation, LimitEntry, Trace } from '@/core/replay/trace';
import { parseTrace } from '@/core/replay/trace';

const at = (limitMps: number | null, fromTs = T0, over: Partial<LimitEntry> = {}): LimitEntry => ({
  fromTs,
  limitMps,
  source: 'posted',
  matchConfidence: 1,
  parallelRoads: false,
  ...over,
});

const L35 = at(mph(35));

/** Twenty seconds at 20 m/s: over a 35 mph limit the whole way, so one speeding event, q 0.9. */
const trace = (over: Partial<Trace> = {}): Trace => ({
  name: 'unit',
  mode: 'mounted',
  night: false,
  precipitation: false,
  rows: seq([20, { speed: 20 }]),
  limits: [L35],
  expected: [],
  ...over,
});

// --- schema -------------------------------------------------------------------------------------

test('a trace survives a JSON round trip', () => {
  const t = trace({ expected: [{ category: 'speeding', startsNear: T0, qMin: 0.8 }] });
  expect(parseTrace(JSON.parse(JSON.stringify(t)))).toEqual(t);
});

test('a missing top-level field is rejected, naming it', () => {
  const bad: Record<string, unknown> = { ...trace() };
  delete bad.rows;
  expect(() => parseTrace(bad)).toThrow(/rows/);
});

test('a bad field inside a row is rejected, naming the row and the field', () => {
  const bad = trace({ rows: [{ ...row(), speed: 'fast' } as unknown as FeatureRow] });
  expect(() => parseTrace(bad)).toThrow(/rows\.0\.speed/);
});

test('an unknown limit source is rejected, naming the entry', () => {
  const bad = trace({ limits: [{ ...L35, source: 'guess' } as unknown as LimitEntry] });
  expect(() => parseTrace(bad)).toThrow(/limits\.0\.source/);
});

test('absent is a flag, not a switch: only true is accepted', () => {
  const bad = trace({
    expected: [{ category: 'phone', startsNear: T0, absent: false } as unknown as Expectation],
  });
  expect(() => parseTrace(bad)).toThrow(/expected\.0\.absent/);
});

test('noEvents is a flag too', () => {
  expect(() => parseTrace({ ...trace(), noEvents: false })).toThrow(/noEvents/);
});

test('an expected status has to be one a detector can produce', () => {
  const bad = trace({
    expected: [{ category: 'phone', startsNear: T0, status: 'disputed' } as unknown as Expectation],
  });
  expect(() => parseTrace(bad)).toThrow(/expected\.0\.status/);
});

test('a key nobody reads is rejected rather than silently dropped', () => {
  expect(() => parseTrace({ ...trace(), tolerance: 2 })).toThrow(/tolerance/);
});

test('the error names every problem at once', () => {
  const bad: Record<string, unknown> = { ...trace(), mode: 'boot', night: 'yes' };
  expect(() => parseTrace(bad)).toThrow(/mode.*night|night.*mode/s);
});

// --- the runner ---------------------------------------------------------------------------------

test('every row is fed the limit in force at its ts', () => {
  const res = runTrace(trace({ limits: [at(30), at(mph(35), T0 + 10_000)] }));
  expect(res.events.map((e) => [e.category, e.startedAt, e.durationS])).toEqual([
    ['speeding', T0 + 10_000, 10],
  ]);
});

test('rows before the first limit sample have no limit at all', () => {
  const res = runTrace(trace({ limits: [at(mph(35), T0 + 5_000)] }));
  expect(res.events.map((e) => [e.startedAt, e.durationS])).toEqual([[T0 + 5_000, 15]]);
});

test('an episode still open on the last row is closed by flush', () => {
  const res = runTrace(trace());
  expect(res.events.map((e) => [e.category, e.durationS, e.q])).toEqual([['speeding', 20, 0.9]]);
});

test('the trace context reaches the detectors', () => {
  const res = runTrace(trace({ night: true, precipitation: true }));
  expect(res.events[0]?.context).toEqual({ night: true, precipitation: true });
});

test('the drive mode reaches the detectors', () => {
  const rows = seq([4, { appForeground: false, locked: false, screenOn: true }]);
  expect(runTrace(trace({ rows, mode: 'mounted' })).events.map((e) => e.category)).toEqual([
    'phone',
  ]);
  expect(runTrace(trace({ rows, mode: 'pocket' })).events).toEqual([]);
});

// --- expectations -------------------------------------------------------------------------------

test('a trace with no expectations passes', () => {
  expect(runTrace(trace())).toMatchObject({ passes: true, failures: [] });
});

test('an expectation the events meet passes', () => {
  const res = runTrace(
    trace({
      expected: [
        { category: 'speeding', startsNear: T0, qMin: 0.8, durationMin: 20, durationMax: 20 },
        { category: 'phone', startsNear: T0, absent: true },
      ],
    })
  );
  expect(res).toMatchObject({ passes: true, failures: [] });
});

test('an expectation nothing matches fails with a readable line, named by trace', () => {
  const res = runTrace(trace({ expected: [{ category: 'phone', startsNear: T0 + 3_000 }] }));
  expect(res.passes).toBe(false);
  expect(res.failures).toEqual([
    'unit: phone expected near +3 s (±2 s): no phone event there; phone events: none',
  ]);
});

test('the failure line lists the events of the category that did not line up', () => {
  const res = runTrace(trace({ expected: [{ category: 'speeding', startsNear: T0 + 30_000 }] }));
  expect(res.failures).toEqual([
    'unit: speeding expected near +30 s (±2 s): no speeding event there; ' +
      'speeding events: speeding +0 s q=0.90 scored 20 s',
  ]);
});

test('startsNear is matched within a default of two seconds, or toleranceS when given', () => {
  const near = (startsNear: number, toleranceS?: number): boolean =>
    runTrace(trace({ expected: [{ category: 'speeding', startsNear, toleranceS }] })).passes;
  expect(near(T0 + 2_000)).toBe(true);
  expect(near(T0 - 2_000)).toBe(true);
  expect(near(T0 + 2_001)).toBe(false);
  expect(near(T0 + 5_000, 5)).toBe(true);
  expect(near(T0 + 5_001, 5)).toBe(false);
});

test('two events in the window are an ambiguous expectation, not a pass', () => {
  const rows = seq([8, { speed: 20 }], [2, { speed: 10 }], [8, { speed: 20 }]);
  const res = runTrace(
    trace({ rows, expected: [{ category: 'speeding', startsNear: T0, toleranceS: 30 }] })
  );
  expect(res.passes).toBe(false);
  expect(res.failures[0]).toMatch(/2 speeding events there, expected one/);
});

test('qMin, qMax, durationMin and durationMax each fail on their own line', () => {
  const fails = (e: Expectation): string[] => runTrace(trace({ expected: [e] })).failures;
  const near = { category: 'speeding', startsNear: T0 } as const;
  expect(fails({ ...near, qMin: 0.95 })).toEqual([
    'unit: speeding +0 s: q 0.90 is below qMin 0.95',
  ]);
  expect(fails({ ...near, qMax: 0.5 })).toEqual(['unit: speeding +0 s: q 0.90 is above qMax 0.5']);
  expect(fails({ ...near, durationMin: 25 })).toEqual([
    'unit: speeding +0 s: durationS 20 is below durationMin 25',
  ]);
  expect(fails({ ...near, durationMax: 10 })).toEqual([
    'unit: speeding +0 s: durationS 20 is above durationMax 10',
  ]);
  expect(fails({ ...near, qMin: 0.95, durationMin: 25 })).toHaveLength(2);
});

test('a scored expectation fails when the detector only thought it possible', () => {
  // Handling at a red light: the same signal, logged but never scored.
  const rows = seq([5, { speed: 0, handlingScore: 0.8 }], [3, { speed: 0 }]);
  const scored = runTrace(
    trace({ rows, expected: [{ category: 'phone', startsNear: T0, status: 'scored' }] })
  );
  expect(scored.passes).toBe(false);
  expect(scored.failures).toEqual(['unit: phone +0 s: status possible, expected scored']);
  const possible = runTrace(
    trace({ rows, expected: [{ category: 'phone', startsNear: T0, status: 'possible' }] })
  );
  expect(possible).toMatchObject({ passes: true, failures: [] });
});

test('a possible expectation fails when the detector scored it after all', () => {
  const res = runTrace(
    trace({ expected: [{ category: 'speeding', startsNear: T0, status: 'possible' }] })
  );
  expect(res.failures).toEqual(['unit: speeding +0 s: status scored, expected possible']);
});

test('noEvents fails on any event at all, whatever its status', () => {
  const rows = seq([5, { speed: 0, handlingScore: 0.8 }], [3, { speed: 0 }]);
  expect(runTrace(trace({ rows, noEvents: true })).failures).toEqual([
    'unit: expected no events at all; 1 turned up: phone +0 s q=0.60 possible 5 s',
  ]);
});

test('noEvents passes on a drive that produced nothing', () => {
  const rows = seq([20, { speed: 10 }]);
  expect(runTrace(trace({ rows, noEvents: true }))).toMatchObject({ passes: true, failures: [] });
});

test('absent means no scored event in the category, so a possible one is fine', () => {
  const rows = seq([5, { speed: 0, handlingScore: 0.8 }], [3, { speed: 0 }]);
  const res = runTrace(
    trace({ rows, expected: [{ category: 'phone', startsNear: T0, absent: true }] })
  );
  expect(res.events.map((e) => [e.category, e.status])).toEqual([['phone', 'possible']]);
  expect(res.passes).toBe(true);
});

test('absent fails when the category did score, whatever the timing', () => {
  const rows = seq([5, { speed: 15, handlingScore: 0.8 }], [3, { speed: 15 }]);
  const res = runTrace(
    trace({ rows, expected: [{ category: 'phone', startsNear: T0 + 60_000, absent: true }] })
  );
  expect(res.passes).toBe(false);
  expect(res.failures).toEqual([
    'unit: phone expected absent: 1 scored phone event: phone +0 s q=0.60 scored 5 s',
  ]);
});
