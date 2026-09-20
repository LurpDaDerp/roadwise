import { scoreTrip } from '../src/scoreTrip';
import type { ScorableEvent, TripMetrics } from '../src/types';
const mph = (v: number) => v * 0.44704;
const metrics: TripMetrics = { distanceM: 8 * 1609.344, durationS: 22 * 60, validGnssPct: 98, imuPresent: true, role: 'driver', maxSustainedSpeedMps: mph(60) };
const base = { corrected: false, status: 'scored' as const };
const events: ScorableEvent[] = [
  { id: 'p1', category: 'phone', startedAt: 0, durationS: 12, q: 0.9, ...base, measured: { speedMps: mph(35) }, context: { night: false, precipitation: false } },
  { id: 's1', category: 'speeding', startedAt: 0, durationS: 45, q: 0.85, ...base, measured: { overMps: mph(12), limitMps: mph(35) }, context: { night: false, precipitation: true } },
  { id: 'b1', category: 'braking', startedAt: 0, durationS: 1, q: 0.8, ...base, measured: { peakG: 0.42 }, context: { night: false, precipitation: false } },
];
test('spec §9.4 worked example scores 74 with the stated breakdown', () => {
  const r = scoreTrip(metrics, events);
  expect(r.status).toBe('final');
  expect(r.exposure).toBeCloseTo(1.1, 6);
  expect(r.categoryDeductions.phone).toBeCloseTo(14.545, 2);
  expect(r.categoryDeductions.speeding).toBeCloseTo(6.818, 2);
  expect(r.categoryDeductions.braking).toBeCloseTo(4.773, 2);
  expect(r.score).toBe(74);
});
test('caps bound each category', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...events[0]!, id: `p${i}` }));
  expect(scoreTrip(metrics, many).categoryDeductions.phone).toBe(30);
});
test('possible events (q < 0.5) cost nothing; scaled between 0.5 and 0.8', () => {
  const low = scoreTrip(metrics, [{ ...events[2]!, q: 0.4 }]);
  expect(low.score).toBe(100);
  const mid = scoreTrip(metrics, [{ ...events[2]!, q: 0.6 }]);
  expect(mid.categoryDeductions.braking).toBeCloseTo((3 * 1.75 * 0.6) / 1.1, 3);
});
test('unscored and discarded trips', () => {
  expect(scoreTrip({ ...metrics, role: 'passenger' }, events)).toMatchObject({ status: 'unscored', reason: 'passenger', score: null });
  expect(scoreTrip({ ...metrics, distanceM: 500 }, events)).toMatchObject({ status: 'unscored', reason: 'too_short' });
  expect(scoreTrip({ ...metrics, validGnssPct: 60 }, events)).toMatchObject({ status: 'unscored', reason: 'grade_c', dataQuality: 'C' });
  expect(scoreTrip({ ...metrics, maxSustainedSpeedMps: mph(120) }, events)).toMatchObject({ status: 'discarded', reason: 'implausible_speed' });
});
test('a perfect trip scores 100 and a removed event does not count', () => {
  expect(scoreTrip(metrics, []).score).toBe(100);
  expect(scoreTrip(metrics, [{ ...events[0]!, status: 'removed' }]).score).toBe(100);
});
test('a measurement that is not finite grades the trip C instead of scoring it from NaN', () => {
  for (const bad of [{ distanceM: NaN }, { durationS: NaN }, { validGnssPct: NaN }, { maxSustainedSpeedMps: Infinity }]) {
    const r = scoreTrip({ ...metrics, ...bad }, events);
    expect(r).toMatchObject({ status: 'unscored', reason: 'grade_c', dataQuality: 'C', score: null });
    expect(Number.isFinite(r.exposure)).toBe(true);
  }
});
test('an event whose own numbers are not finite is skipped, like a possible one', () => {
  for (const bad of [{ durationS: NaN }, { durationS: Infinity }, { q: NaN }, { q: Infinity }]) {
    const r = scoreTrip(metrics, [{ ...events[0]!, ...bad }]);
    expect(r).toMatchObject({ status: 'final', score: 100 });
    expect(r.categoryDeductions.phone).toBe(0);
    expect(r.eventDeductions).toEqual({});
  }
});
test('one unusable event does not disturb the others', () => {
  const r = scoreTrip(metrics, [...events, { ...events[0]!, id: 'p2', q: NaN }]);
  expect(r.score).toBe(74);
  expect(r.categoryDeductions.phone).toBeCloseTo(14.545, 2);
  expect(Object.keys(r.eventDeductions).sort()).toEqual(['b1', 'p1', 's1']);
});
