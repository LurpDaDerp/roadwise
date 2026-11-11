import { createWeatherSpeedingWatch } from '@/core/detectors/weatherSpeeding';
import { limit, mph, NO_LIMIT, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { FeatureRow, LimitSample, WeatherSpeedingStretch } from '@/core/engine/types';

// A wet 35 is watched as 31.5: its line is 35.74 (1.16 × 31.5 − 0.8), the end buffer under 33.74.
// The speeding line of the posted 35 is 39.8.
const L35 = limit(mph(35));
const wet = { g: 'wet' } as const;

/** The stretch after each row. */
function watch(rows: FeatureRow[], lim: LimitSample = L35): (WeatherSpeedingStretch | null)[] {
  const w = createWeatherSpeedingWatch();
  return rows.map((r) => {
    w.push(r, lim);
    return w.stretch();
  });
}

describe('the weather "Slow down" watch: over the speeding line of the limit the road state lowered', () => {
  test('38 on a wet 35 opens a stretch on its first over row, naming the grip and the mph past the weather line', () => {
    const got = watch(seq([3, { speed: mph(33), road: wet }], [3, { speed: mph(38), road: wet }]));
    expect(got.slice(0, 3)).toEqual([null, null, null]);
    expect(got[3]).toEqual({ id: `wx-speeding-${T0 + 3000}`, startedAt: T0 + 3000, road: 'wet', over: true, overMph: expect.closeTo(38 - 35.74, 9) });
    expect(got[5]).toMatchObject({ id: `wx-speeding-${T0 + 3000}`, over: true });
  });

  test('an unstamped row, a cap at or above the limit and an unknown stamp are never watched', () => {
    expect(watch(seq([5, { speed: mph(45) }]))).toEqual([null, null, null, null, null]);
    expect(watch(seq([5, { speed: mph(39), road: { cap: 45 } }])).every((s) => s === null)).toBe(true);
    expect(watch(seq([5, { speed: mph(39), road: { g: 'mud' } as unknown as FeatureRow['road'] }])).every((s) => s === null)).toBe(true);
  });

  test('the condition is the one that set the lower limit: fog when the sight cap is lower, else the grip', () => {
    const L65 = limit(mph(65));
    // 65 wet is 58.5; a 35 cap is lower: fog, line 39.8.
    expect(watch(seq([1, { speed: mph(45), road: { g: 'wet', cap: 35 } }]), L65)[0]).toMatchObject({ road: 'fog', overMph: expect.closeTo(45 - 39.8, 9) });
    // 65 snow is 52, under a 55 cap: snow.
    expect(watch(seq([1, { speed: mph(65), road: { g: 'snow', cap: 55 } }]), L65)[0]).toMatchObject({ road: 'snow' });
    expect(watch(seq([1, { speed: mph(38), road: { g: 'water' } }]))[0]).toMatchObject({ road: 'water' });
    expect(watch(seq([1, { speed: mph(38), road: { g: 'ice' } }]))[0]).toMatchObject({ road: 'ice' });
    // The stretch names its latest over row's condition.
    expect(watch(seq([1, { speed: mph(38), road: wet }], [1, { speed: mph(38), road: { g: 'snow' } }]))[1]).toMatchObject({ road: 'snow', id: `wx-speeding-${T0}` });
  });

  test('the speeding detector’s usability rules: a default or no limit, an untrusted speed, a poor fix are not watched', () => {
    const over = { speed: mph(38), road: wet };
    expect(watch(seq([3, over]), NO_LIMIT).every((s) => s === null)).toBe(true);
    expect(watch(seq([3, over]), limit(mph(35), 'statutory')).every((s) => s === null)).toBe(true);
    expect(watch(seq([3, { ...over, speedAcc: 3 }])).every((s) => s === null)).toBe(true);
    expect(watch(seq([3, { ...over, hAcc: 40 }])).every((s) => s === null)).toBe(true);
  });

  test('it ends like a speeding episode: 5 rows under the line less 2 mph; hovering in the buffer neither extends nor ends it', () => {
    const got = watch(seq([2, { speed: mph(38), road: wet }], [6, { speed: mph(35), road: wet }], [1, { speed: mph(37), road: wet }], [5, { speed: mph(30), road: wet }]));
    // Hovering at 35 (between 33.74 and 35.74): held, not over.
    for (const s of got.slice(2, 8)) expect(s).toMatchObject({ id: `wx-speeding-${T0}`, over: false, overMph: 0 });
    // Back over: the same stretch.
    expect(got[8]).toMatchObject({ id: `wx-speeding-${T0}`, over: true });
    // Four rows under: still held; the fifth ends it.
    expect(got[12]).toMatchObject({ id: `wx-speeding-${T0}`, over: false });
    expect(got[13]).toBeNull();
  });

  test('an unstamped row (the weather cleared) or an unusable one counts toward the end; a new over row then opens a new stretch', () => {
    const got = watch(seq([1, { speed: mph(38), road: wet }], [5, { speed: mph(38) }], [1, { speed: mph(38), road: wet }]));
    expect(got[4]).toMatchObject({ over: false });
    expect(got[5]).toBeNull();
    expect(got[6]).toMatchObject({ id: `wx-speeding-${T0 + 6000}`, over: true });
  });

  test('flush drops the stretch', () => {
    const w = createWeatherSpeedingWatch();
    w.push(seq([1, { speed: mph(38), road: wet }])[0]!, L35);
    expect(w.stretch()).not.toBeNull();
    w.flush();
    expect(w.stretch()).toBeNull();
  });
});
