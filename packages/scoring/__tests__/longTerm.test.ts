import { band, longTermScore } from '../src/longTerm';
const day = 86_400_000; const now = 1_800_000_000_000;
const trip = (ageDays: number, score: number, exposure = 1, durationS = 1200) => ({ endedAt: now - ageDays * day, score, exposure, durationS });
test('building the score until 3 trips and 60 minutes', () => {
  expect(longTermScore([trip(1, 90), trip(2, 90)], now)).toMatchObject({ score: null, provisional: true, tripsUsed: 2 });
  expect(longTermScore([trip(1, 90, 1, 600), trip(2, 90, 1, 600), trip(3, 90, 1, 600)], now).score).toBeNull(); // 30 min total
});
test('three equal trips shrink toward the prior 80', () => {
  const r = longTermScore([trip(0, 100), trip(0, 100), trip(0, 100)], now);
  // w = 1 each → (300 + 160) / (3 + 2) = 92
  expect(r.score).toBe(92);
  expect(r.band).toBe('excellent');
});
test('recency half-life 21 days and exposure cap 3', () => {
  const r = longTermScore([trip(21, 60, 10), trip(0, 100, 1), trip(0, 100, 1)], now);
  // weights: 3 × 0.5 = 1.5 for the old trip; 1 and 1 → (90 + 200 + 160) / (3.5 + 2) = 81.8 → 82
  expect(r.score).toBe(82);
  expect(r.band).toBe('good');
});
test('falls back to the last 10 scored trips when fewer than 3 are within 60 days', () => {
  const r = longTermScore([trip(70, 70), trip(80, 70), trip(90, 70), trip(1, 90)], now);
  expect(r.tripsUsed).toBe(4);
});
test('bands', () => {
  expect(band(90)).toBe('excellent'); expect(band(89)).toBe('good'); expect(band(65)).toBe('getting_there'); expect(band(64)).toBe('needs_focus');
});
test('a future-dated trip weighs no more than a fresh one', () => {
  // A clock skewed forward would otherwise give 0.5^(negative) > 1 and let one trip outvote the rest.
  const skewed = longTermScore([trip(-30, 60), trip(0, 100), trip(0, 100)], now);
  const fresh = longTermScore([trip(0, 60), trip(0, 100), trip(0, 100)], now);
  expect(skewed.score).toBe(fresh.score);
});
