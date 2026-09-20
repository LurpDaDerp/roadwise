import { baseWeight, durationFactor, severity } from '../src/severity';
import type { ScorableEvent } from '../src/types';

const ev = (p: Partial<ScorableEvent> & { category: ScorableEvent['category'] }): ScorableEvent => ({
  id: 'e',
  startedAt: 0,
  durationS: 1,
  q: 1,
  corrected: false,
  status: 'scored',
  measured: {},
  context: { night: false, precipitation: false },
  ...p,
});
const mph = (v: number) => v * 0.44704;

test('phone severity by speed', () => {
  expect(severity(ev({ category: 'phone', measured: { speedMps: mph(35) } }))).toBe(1);
  expect(severity(ev({ category: 'phone', measured: { speedMps: mph(15) } }))).toBe(0.7);
  expect(severity(ev({ category: 'phone', measured: { speedMps: mph(5) } }))).toBe(0.3);
  expect(severity(ev({ category: 'phone', measured: { speedMps: 0 } }))).toBe(0);
});

test('speeding severity is the greater of absolute and percentage bands', () => {
  expect(severity(ev({ category: 'speeding', measured: { overMps: mph(12), limitMps: mph(35) } }))).toBe(2); // 10–14 → 2; 34% → 2
  expect(severity(ev({ category: 'speeding', measured: { overMps: mph(7), limitMps: mph(15) } }))).toBe(3.5); // 5–9 → 1 but 47% → 3.5
  expect(severity(ev({ category: 'speeding', measured: { overMps: mph(21), limitMps: mph(65) } }))).toBe(5);
});

test('harsh severities by g', () => {
  expect(severity(ev({ category: 'braking', measured: { peakG: 0.42 } }))).toBe(1.75);
  expect(severity(ev({ category: 'braking', measured: { peakG: 0.6 } }))).toBe(2.5);
  expect(severity(ev({ category: 'accel', measured: { peakG: 0.3 } }))).toBe(1);
  expect(severity(ev({ category: 'cornering', measured: { lateralG: 0.5 } }))).toBe(1.75);
});

test('focus severity', () => {
  expect(severity(ev({ category: 'focus', measured: { glanceS: 2.5, focusKind: 'glance' } }))).toBe(1);
  expect(severity(ev({ category: 'focus', measured: { glanceS: 6, focusKind: 'glance' } }))).toBe(3);
  expect(severity(ev({ category: 'focus', measured: { focusKind: 'drowsiness' } }))).toBe(2);
  expect(baseWeight(ev({ category: 'focus', measured: { focusKind: 'drowsiness' } }))).toBe(6);
});

// Band edges are lower-bound inclusive (`>=`); the four open-ended top bands the spec writes as
// strict (`> 0.55 g`, `> 0.38 g`, `> 0.45 g`, `> 5 s`) must be exceeded, not merely touched. These
// tables exist so that flipping any comparison fails a test.
describe('band boundaries', () => {
  // A 65 mph limit keeps every percentage band below the absolute one, isolating the absolute edges.
  test.each([
    [mph(9.99), 1],
    [mph(10), 2],
    [mph(14.99), 2],
    [mph(15), 3.5],
    [mph(19.99), 3.5],
    [mph(20), 5],
  ])('speeding over %p m/s in a 65 → %p', (overMps, want) => {
    expect(severity(ev({ category: 'speeding', measured: { overMps, limitMps: mph(65) } }))).toBe(
      want
    );
  });

  test.each([
    [NaN, 0],
    [mph(0), 0],
    [mph(9.99), 0.3],
    [mph(10), 0.7],
    [mph(24.99), 0.7],
    [mph(25), 1],
  ])('phone at %p m/s → %p', (speedMps, want) => {
    expect(severity(ev({ category: 'phone', measured: { speedMps } }))).toBe(want);
  });

  test.each([
    [0.29, 0],
    [0.3, 1],
    [0.39, 1],
    [0.4, 1.75],
    [0.55, 1.75],
    [0.56, 2.5],
  ])('braking at %p g → %p', (peakG, want) => {
    expect(severity(ev({ category: 'braking', measured: { peakG } }))).toBe(want);
  });

  test.each([
    [0.27, 0],
    [0.28, 1],
    [0.38, 1],
    [0.381, 1.75],
  ])('accel at %p g → %p', (peakG, want) => {
    expect(severity(ev({ category: 'accel', measured: { peakG } }))).toBe(want);
  });

  test.each([
    [0.34, 0],
    [0.35, 1],
    [0.45, 1],
    [0.451, 1.75],
  ])('cornering at %p g → %p', (lateralG, want) => {
    expect(severity(ev({ category: 'cornering', measured: { lateralG } }))).toBe(want);
  });

  test.each([
    [1.99, 0],
    [2, 1],
    [2.99, 1],
    [3, 2],
    [5, 2],
    [5.01, 3],
  ])('glance of %p s → %p', (glanceS, want) => {
    expect(severity(ev({ category: 'focus', measured: { glanceS, focusKind: 'glance' } }))).toBe(
      want
    );
  });
});

test('duration factors and correction credit', () => {
  expect(durationFactor(ev({ category: 'phone', durationS: 12 }))).toBe(2);
  expect(durationFactor(ev({ category: 'phone', durationS: 1 }))).toBe(0.5);
  expect(durationFactor(ev({ category: 'speeding', durationS: 45 }))).toBe(1.5);
  expect(durationFactor(ev({ category: 'speeding', durationS: 600 }))).toBe(4);
  expect(durationFactor(ev({ category: 'speeding', durationS: 45, corrected: true }))).toBe(0.5);
  expect(durationFactor(ev({ category: 'braking', durationS: 3 }))).toBe(1);
});
