import { statColor, statsFrom, type StatId, type StatSums } from '../src/stats';

describe('statColor — spec thresholds (green ≤ bound inclusive, red strictly beyond)', () => {
  // [id, last green, first yellow, last yellow, first red]
  test.each([
    ['speeding', 1, 1.01, 4, 4.01],
    ['harsh', 4, 4.01, 12, 12.01],
    ['hard_brake', 2, 2.01, 6, 6.01],
    ['hard_accel', 2, 2.01, 6, 6.01],
    ['hard_corner', 2, 2.01, 6, 6.01],
  ] as const)('%s', (id, g, y1, y2, r) => {
    expect(statColor(id, g)).toBe('green');
    expect(statColor(id, y1)).toBe('yellow');
    expect(statColor(id, y2)).toBe('yellow');
    expect(statColor(id, r)).toBe('red');
  });

  test('clean drives: green ≥ 80, red < 50', () => {
    expect(statColor('clean', 100)).toBe('green');
    expect(statColor('clean', 80)).toBe('green');
    expect(statColor('clean', 79.99)).toBe('yellow');
    expect(statColor('clean', 50)).toBe('yellow');
    expect(statColor('clean', 49.99)).toBe('red');
  });

  test.each(['miles', 'duration', 'night_miles'] as const)('%s has no colour', (id) =>
    expect(statColor(id, 123)).toBeNull());

  test('no value → no colour', () => expect(statColor('speeding', null)).toBeNull());
});

const sums: StatSums = {
  miles: 200,
  durationS: 7200,
  nightMiles: 20,
  drives: 10,
  cleanDrives: 8,
  speeding: 3,
  hardBrake: 4,
  hardAccel: 2,
  hardCorner: 1,
};

describe('statsFrom', () => {
  const byId = (s: StatSums) => Object.fromEntries(statsFrom(s).map((x) => [x.id, x]));

  test('per-100-mi rates, clean % and totals', () => {
    const st = byId(sums);
    expect(st.speeding).toMatchObject({ value: 1.5, total: 3, unit: 'per_100_mi', color: 'yellow', home: true });
    expect(st.harsh).toMatchObject({ value: 3.5, total: 7, color: 'green', home: true });
    expect(st.clean).toMatchObject({ value: 80, total: 8, unit: 'pct', color: 'green', home: true });
    expect(st.hard_brake).toMatchObject({ value: 2, total: 4, color: 'green', home: false });
    expect(st.hard_accel).toMatchObject({ value: 1, color: 'green' });
    expect(st.hard_corner).toMatchObject({ value: 0.5, color: 'green' });
    expect(st.miles).toMatchObject({ value: 200, total: 200, unit: 'mi', color: null, home: true });
    expect(st.duration).toMatchObject({ value: 2, total: 2, unit: 'h', color: null });
    expect(st.night_miles).toMatchObject({ value: 20, total: 20, unit: 'mi', color: null });
  });

  test('home shows exactly the 4 headline stats, in spec order', () =>
    expect(statsFrom(sums).filter((s) => s.home).map((s) => s.id)).toEqual<StatId[]>(['speeding', 'harsh', 'clean', 'miles']));

  test('no phone-use stat is left', () =>
    expect(statsFrom(sums).map((s) => s.id)).toEqual<StatId[]>([
      'speeding',
      'harsh',
      'clean',
      'hard_brake',
      'hard_accel',
      'hard_corner',
      'miles',
      'duration',
      'night_miles',
    ]));

  test('no miles, drives or time → rates are null and uncoloured', () => {
    const st = byId({ ...sums, miles: 0, drives: 0, cleanDrives: 0, durationS: 0, nightMiles: 0 });
    expect(st.speeding).toMatchObject({ value: null, color: null, total: 3 });
    expect(st.clean).toMatchObject({ value: null, color: null });
    expect(st.miles).toMatchObject({ value: 0, color: null });
  });

  test('rates are rounded to 2 dp', () => expect(byId({ ...sums, miles: 300 }).speeding!.value).toBe(1));
});
