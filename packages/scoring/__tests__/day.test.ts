import { evaluateDay } from '../src/day';
const t = (score: number | null, durationS = 900, extra: Partial<{ hadSevereEvent: boolean; phoneEvents: number; cameraGood: boolean; status: 'final' | 'unscored' | 'discarded' }> = {}) => ({ score, status: (extra.status ?? (score === null ? 'unscored' : 'final')) as 'final' | 'unscored' | 'discarded', durationS, hadSevereEvent: false, phoneEvents: 0, cameraGood: false, ...extra });
test('safe day: avg ≥ 85, no severe event, ≥ 10 min driving → 50 (+25 phone-free)', () => {
  expect(evaluateDay({ trips: [t(90), t(84)] })).toMatchObject({ safeDay: true, phoneFreeDay: true, points: 75 });
});
test('good day 70–84 → 20; a severe event breaks a safe day but not a good day', () => {
  expect(evaluateDay({ trips: [t(80)] })).toMatchObject({ safeDay: false, goodDay: true, points: 45 });
  expect(evaluateDay({ trips: [t(95, 900, { hadSevereEvent: true })] })).toMatchObject({ safeDay: false, goodDay: true });
});
test('under 10 minutes of driving earns no day points', () => {
  expect(evaluateDay({ trips: [t(100, 300)] })).toMatchObject({ safeDay: false, goodDay: false, points: 25 });
});
test('unscored trips do not count; camera day adds 10', () => {
  expect(evaluateDay({ trips: [t(null), t(90, 900, { cameraGood: true, phoneEvents: 1 })] })).toMatchObject({ safeDay: true, phoneFreeDay: false, cameraDay: true, points: 60 });
});
