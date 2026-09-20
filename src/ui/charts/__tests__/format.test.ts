import {
  BAND_FLOORS,
  bandLabel,
  describeBars,
  describeScore,
  describeTrend,
  formatPoints,
  formatScore,
} from '@/ui/charts/format';

test('band labels are the spec words, not grades', () => {
  expect(bandLabel('excellent')).toBe('Excellent');
  expect(bandLabel('good')).toBe('Good');
  expect(bandLabel('getting_there')).toBe('Getting there');
  expect(bandLabel('needs_focus')).toBe('Needs focus');
});

test('band floors come from the engine, highest first', () => {
  expect(BAND_FLOORS.map((b) => b.floor)).toEqual([90, 80, 65, 0]);
});

test('a score prints whole and inside 0..100', () => {
  expect(formatScore(73.6)).toBe('74');
  expect(formatScore(120)).toBe('100');
  expect(formatScore(-3)).toBe('0');
});

test('points keep one decimal only when they need it', () => {
  expect(formatPoints(6)).toBe('6');
  expect(formatPoints(6.25)).toBe('6.3');
  expect(formatPoints(0.4)).toBe('0.4');
  expect(formatPoints(12.04)).toBe('12');
  expect(formatPoints(Number.NaN)).toBe('—');
});

test('the ring speaks the score, its band and whether it is provisional', () => {
  expect(describeScore(74, 'getting_there')).toBe('Score 74, Getting there');
  expect(describeScore(74, 'getting_there', true)).toBe('Score 74, Getting there, provisional');
});

describe('describeTrend', () => {
  const w = (value: number | null, label = 'w') => ({ label, value });

  test('names both ends and the whole span', () => {
    expect(describeTrend([w(71), w(76), w(80), w(84)])).toBe(
      'Score trend, from 71 to 84 over 4 weeks'
    );
  });

  test('a period without a score still counts toward the span', () => {
    expect(describeTrend([w(71), w(null), w(84)])).toBe(
      'Score trend, from 71 to 84 over 3 weeks'
    );
  });

  test('one score is stated, not a range', () => {
    expect(describeTrend([w(84)])).toBe('Score trend, 84');
    expect(describeTrend([w(null), w(84), w(null)])).toBe('Score trend, 84 over 3 weeks');
  });

  test('no scores says so', () => {
    expect(describeTrend([])).toBe('Score trend, no scores yet');
    expect(describeTrend([w(null)])).toBe('Score trend, no scores yet');
  });

  test('the period can be something other than weeks', () => {
    expect(describeTrend([w(70), w(90)], { one: 'month', many: 'months' })).toBe(
      'Score trend, from 70 to 90 over 2 months'
    );
  });
});

test('bars are read as "label, lost of cap points"', () => {
  expect(
    describeBars([
      { label: 'Phone use', value: 0, cap: 30 },
      { label: 'Speeding', value: 12, cap: 25 },
    ])
  ).toBe('Points lost by category. Phone use 0 of 30 points, Speeding 12 of 25 points');
  expect(describeBars([])).toBe('Points lost by category, none');
});
