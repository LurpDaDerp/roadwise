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

test('duration factors and correction credit', () => {
  expect(durationFactor(ev({ category: 'phone', durationS: 12 }))).toBe(2);
  expect(durationFactor(ev({ category: 'phone', durationS: 1 }))).toBe(0.5);
  expect(durationFactor(ev({ category: 'speeding', durationS: 45 }))).toBe(1.5);
  expect(durationFactor(ev({ category: 'speeding', durationS: 600 }))).toBe(4);
  expect(durationFactor(ev({ category: 'speeding', durationS: 45, corrected: true }))).toBe(0.5);
  expect(durationFactor(ev({ category: 'braking', durationS: 3 }))).toBe(1);
});
