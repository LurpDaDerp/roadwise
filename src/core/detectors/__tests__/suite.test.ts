import { createDetectors, mergeEvents } from '@/core/detectors';
import type { DetectorContext, FeatureRow } from '@/core/engine/types';
import { T0, counterIds, ctx, limit, mph, only, row, seq } from '../__fixtures__/rows';

const L35 = limit(mph(35));
const OVER = { speed: mph(45) };
const UNDER = { speed: mph(30) };
const HAND = { handlingScore: 0.7 };
const G = 9.80665;

test('push fans out to every detector and returns only what closed on that row', () => {
  const suite = createDetectors(counterIds());
  // handling on rows 0-2 closes on row 4; speeding on rows 0-5 closes on row 6
  const list = seq([3, { ...OVER, ...HAND }], [3, OVER], [1, UNDER]);
  const pushed = list.map((r) => suite.push(r, L35, ctx()));
  expect(pushed[4]!.map((e) => e.category)).toEqual(['phone']);
  expect(pushed[6]!.map((e) => e.category)).toEqual(['speeding']);
  expect(pushed.flat()).toHaveLength(2);
  expect(suite.flush()).toEqual([]);
});

test('harsh events come through with their two-second orientation look-ahead', () => {
  const suite = createDetectors(counterIds());
  const list = seq([1, {}], [1, { aLonMin: -0.35, speed: 15 - 0.25 * G }], [2, { speed: 15 - 0.25 * G }]);
  const pushed = list.map((r) => suite.push(r, L35, ctx()));
  expect(pushed.slice(0, 3).flat()).toEqual([]);
  expect(only(pushed[3]!)).toMatchObject({ category: 'braking', q: 0.95, source: 'both' });
});

test('flush closes open episodes across detectors, sorted by start', () => {
  const suite = createDetectors(counterIds());
  seq([2, OVER], [4, { ...OVER, ...HAND }]).forEach((r) => suite.push(r, L35, ctx()));
  expect(suite.flush().map((e) => [e.category, e.startedAt])).toEqual([
    ['speeding', T0],
    ['phone', T0 + 2000],
  ]);
});

test('markAlerted reaches the open speeding episode', () => {
  const suite = createDetectors(counterIds());
  seq([6, OVER]).forEach((r) => suite.push(r, L35, ctx()));
  const id = suite.openSpeedingEpisodeId();
  expect(id).toBe('e1');
  suite.markAlerted(id!, T0 + 5000);
  expect(only(suite.push(row(UNDER, 6), L35, ctx()))).toMatchObject({
    category: 'speeding',
    corrected: true,
  });
  expect(suite.openSpeedingEpisodeId()).toBeNull();
});

test('a camera focus event closing on the same row as a phone episode is merged into it', () => {
  const suite = createDetectors(counterIds());
  const focus = { glanceS: 2.5, kind: 'glance' as const, q: 0.9 };
  const pushed = seq([3, HAND], [2, {}]).map((r, i) =>
    suite.push(r, L35, ctx({ cameraFocus: i === 4 ? focus : null }))
  );
  expect(pushed.slice(0, 4).flat()).toEqual([]);
  expect(only(pushed[4]!)).toMatchObject({
    id: 'e1',
    category: 'phone',
    q: 0.9,
    source: 'both',
    startedAt: T0,
    durationS: 4,
    absorbedIds: ['e2'],
    measured: { speedMps: 15, glanceS: 2.5 },
  });
});

describe('mergeEvents over the whole trip keeps possible events apart', () => {
  // The finalizer runs `mergeEvents` over every event of the trip; a stopped stretch (possible,
  // speed 0) must never be folded into the scored moving stretch next to it.
  const trip = (rows: FeatureRow[], ctxAt: (i: number) => DetectorContext = () => ctx()) => {
    const suite = createDetectors(counterIds());
    const pushed = rows.map((r, i) => suite.push(r, L35, ctxAt(i)));
    return mergeEvents([...pushed.flat(), ...suite.flush()]);
  };
  const facts = (all: ReturnType<typeof trip>) =>
    all.map((e) => [e.category, e.status, e.durationS, e.measured.speedMps, e.q]);

  test('(a1) stopped then moving handling with equal q stay two events', () => {
    const all = trip(seq([3, { ...HAND, speed: 0 }], [3, HAND], [2, {}]));
    expect(facts(all)).toEqual([
      ['phone', 'possible', 3, 0, 0.6],
      ['phone', 'scored', 3, 15, 0.6],
    ]);
  });

  test('(a2) unlock evidence on the moving stretch does not pull the stopped seconds into it', () => {
    const unlocked = { ...HAND, locked: false, screenOn: true };
    const all = trip(seq([3, { ...HAND, speed: 0 }], [3, unlocked], [2, {}]));
    expect(facts(all)).toEqual([
      ['phone', 'possible', 3, 0, 0.6],
      ['phone', 'scored', 3, 15, 0.9],
    ]);
  });

  test('(a3) drowsiness during stopped handling keeps its own scored event', () => {
    const drowsy = { glanceS: 0, kind: 'drowsiness' as const, q: 0.7 };
    const all = trip(seq([3, { ...HAND, speed: 0 }], [2, { speed: 0 }]), (i) =>
      ctx({ cameraFocus: i === 1 ? drowsy : null })
    );
    expect(facts(all)).toEqual([
      ['phone', 'possible', 3, 0, 0.6],
      ['focus', 'scored', 0, 0, 0.7],
    ]);
  });
});
