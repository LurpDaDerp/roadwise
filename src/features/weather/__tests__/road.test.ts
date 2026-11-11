import type { RoadStamp } from '@scoring';

import { roadCopy, roadKind, roadSpoken, roadTitle, WET_ROAD_KIND } from '../copy';
import { inRoadCell, roadStateAt, roadTitleAt, sightCapOf, stepIndexAt, type RoadSeries, type RoadStep } from '../road';
import { ROAD_HISTORY_STEPS, ROAD_STALE_MS, SIGHT_BANDS, WATER_FILM } from '../thresholds';

const LAT = 47.6;
const LNG = -122.3;
/** Step 0's time (unix seconds). */
const T0 = 1_792_372_500;

const step = (i: number, over: Partial<RoadStep> = {}): RoadStep => ({
  t: T0 + i * 900,
  code: 3,
  tempC: 8,
  rain15: 0,
  precip15: 0,
  snow15: 0,
  windMph: 5,
  gustMph: 8,
  visM: 16000,
  isDay: true,
  ...over,
});

/** `n` steps, each from `fill`. */
const steps = (n: number, fill: (i: number) => Partial<RoadStep> = () => ({})): RoadStep[] => Array.from({ length: n }, (_, i) => step(i, fill(i)));

const ms = (i: number): number => (T0 + i * 900) * 1000;

/** The state at step `i`, fetched as that step began. */
const at = (list: RoadStep[], i: number, where: { lat?: number; lng?: number } = {}): RoadStamp | null =>
  roadStateAt({ lat: LAT, lng: LNG, fetchedAtMs: ms(i), steps: list }, ms(i), where.lat ?? LAT, where.lng ?? LNG);

/** The grip at step `i` (undefined: dry). */
const gripAt = (list: RoadStep[], i: number) => at(list, i)?.g;

/** Steady rain of `mmH` from step 24 on, cool and dark (slow drying); the first step the road reads wet, in minutes of rain. */
function minutesToWet(mmH: number, over: Partial<RoadStep> = { isDay: false, tempC: 6 }): number | null {
  const list = steps(24 + 48, (i) => ({ ...over, rain15: i >= 24 ? mmH / 4 : 0 }));
  for (let i = 24; i < list.length; i += 1) if (gripAt(list, i) === 'wet') return (i - 24 + 1) * 15;
  return null;
}

describe('the water film: light drizzle never wets the road', () => {
  test('drizzle at 0.2 to 0.3 mm an hour, 12 hours long, cool or dark: never wet', () => {
    expect(minutesToWet(0.2)).toBeNull();
    expect(minutesToWet(0.3)).toBeNull();
    expect(minutesToWet(0.3, { isDay: true, tempC: 4 })).toBeNull();
  });

  test('steady 0.4 mm an hour: wet after 3 hours; 0.6: after an hour; 1: after 30 min; 2.6: in the first step', () => {
    expect(minutesToWet(0.4)).toBe(180);
    expect(minutesToWet(0.6)).toBe(60);
    expect(minutesToWet(1)).toBe(30);
    expect(minutesToWet(2.6, { isDay: true, tempC: 6 })).toBe(15);
  });

  test('after rain stops: dry in an hour on a warm day, two and a half hours cool (the hold included)', () => {
    const afterRain = (over: Partial<RoadStep>): (string | undefined)[] => {
      const list = steps(60, (i) => ({ ...over, rain15: i >= 26 && i < 30 ? 1.5 : 0 }));
      return Array.from({ length: 12 }, (_, k) => gripAt(list, 30 + k));
    };
    // Warm day: the film 0.8 at the end of the rain dries 0.2 a step.
    expect(afterRain({ isDay: true, tempC: 14 })).toEqual(['wet', 'wet', 'wet', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    // Cool: 0.925 drying 0.075 a step.
    expect(afterRain({ isDay: true, tempC: 5 })).toEqual(['wet', 'wet', 'wet', 'wet', 'wet', 'wet', 'wet', 'wet', 'wet', undefined, undefined, undefined]);
  });

  test('the wet line: a film of 0.30 mm is wet, 0.29 is not', () => {
    const one = (mm: number) => gripAt(steps(30, (i) => ({ rain15: i === 28 ? mm : 0 })), 28);
    expect(WATER_FILM.wetMm).toBe(0.3);
    expect(one(0.3 + WATER_FILM.dryCoolMm)).toBe('wet');
    expect(one(0.29 + WATER_FILM.dryCoolMm)).toBeUndefined();
  });

  test('snow feeds the film at its water: a light snow that settles wets the road, flurries do not', () => {
    // 0.5 cm an hour (0.71 mm of water a step): wet within 45 min, "Slippery roads" in the cold.
    const light = steps(40, (i) => ({ tempC: -1, isDay: false, code: 71, snow15: i >= 24 ? 0.125 : 0 }));
    expect([24, 25, 26].map((i) => gripAt(light, i))).toEqual([undefined, undefined, 'wet']);
    expect(roadTitleAt({ lat: LAT, lng: LNG, fetchedAtMs: ms(26), steps: light }, ms(26), at(light, 26))).toBe('Slippery roads');
    // Flurries, 0.1 cm an hour for 12 hours: never.
    const flurries = steps(24 + 48, () => ({ tempC: -1, isDay: false, code: 71, snow15: 0.025 }));
    for (let i = 24; i < flurries.length; i += 1) expect(at(flurries, i)).toEqual({});
  });
});

describe('the grip, each rule at its line and just under', () => {
  /** The grip at step 28 with `now` on step 28 and the rest dry (unless `back` says). */
  const grip = (now: Partial<RoadStep>, back: Record<number, Partial<RoadStep>> = {}) =>
    gripAt(steps(30, (i) => (i === 28 ? now : (back[i] ?? {}))), 28);

  test('ice: a freezing rain or drizzle code', () => {
    for (const code of [56, 57, 66, 67]) expect(grip({ code })).toBe('ice');
    expect(grip({ code: 55 })).toBeUndefined();
  });

  test('ice: at or below 0 °C after 0.5 mm of rain in 3 hours, or with rain falling at 0.5 mm an hour', () => {
    const frozen = { tempC: 0 };
    const cold = (i: number, mm: number) => ({ ...Object.fromEntries(Array.from({ length: 28 }, (_, k) => [k, frozen])), [i]: { ...frozen, rain15: mm } });
    expect(grip(frozen, cold(17, 0.5))).toBe('ice');
    expect(grip(frozen, cold(17, 0.49))).toBeUndefined();
    // 12 steps back is still in the step before's 3 hours (the hold); 13 back is outside both.
    expect(grip(frozen, cold(16, 0.5))).toBe('ice');
    expect(grip(frozen, cold(15, 0.5))).toBeUndefined();
    expect(grip({ tempC: 0.1 }, { ...cold(17, 0.5), 27: { tempC: 0.1 } })).toBeUndefined();
    expect(grip({ tempC: 0, rain15: 0.125 })).toBe('ice');
    expect(grip({ tempC: 0, rain15: 0.12 })).not.toBe('ice');
    expect(grip({ tempC: null, rain15: 0.5 })).toBe('wet');
  });

  test('snow: falling at 2.5 cm an hour, or 2.5 cm in 6 hours at 1 °C or colder', () => {
    expect(grip({ tempC: 3, snow15: 0.625 })).toBe('snow');
    expect(grip({ tempC: 3, snow15: 0.62 })).toBe('wet');
    const cold = { tempC: 1 };
    const fell = (i: number, cm: number) => ({ ...Object.fromEntries(Array.from({ length: 28 }, (_, k) => [k, cold])), [i]: { ...cold, snow15: cm } });
    expect(grip(cold, fell(5, 2.5))).toBe('snow');
    expect(grip(cold, fell(5, 2.49))).toBeUndefined();
    // 24 steps back is still in the step before's 6 hours (the hold); 25 back is outside both.
    expect(grip(cold, fell(4, 2.5))).toBe('snow');
    expect(grip(cold, fell(3, 2.5))).toBeUndefined();
    expect(grip({ tempC: 1.1 }, { ...fell(5, 2.5), 27: { tempC: 1.1 } })).toBeUndefined();
    expect(grip({ tempC: null }, { ...fell(5, 2.5), 27: { tempC: null } })).toBeUndefined();
  });

  test('water: heavy rain (7.6 mm an hour), 19 mm in 3 hours, or moderate rain (2.6) in the dark', () => {
    expect(grip({ rain15: 1.9 })).toBe('water');
    expect(grip({ rain15: 1.89 })).toBe('wet');
    expect(grip({}, { 17: { rain15: 19 } })).toBe('water');
    expect(grip({}, { 17: { rain15: 18.99 } })).toBeUndefined();
    expect(grip({ isDay: false, rain15: 0.65 }, { 27: { isDay: false } })).toBe('water');
    expect(grip({ isDay: false, rain15: 0.64 }, { 27: { isDay: false } })).toBe('wet');
    expect(grip({ isDay: true, rain15: 0.65 })).toBe('wet');
    expect(grip({ isDay: null, rain15: 0.65 })).toBe('wet');
  });

  test('ice outranks snow outranks water outranks wet', () => {
    expect(grip({ code: 66, tempC: -1, snow15: 1, rain15: 2 })).toBe('ice');
    expect(grip({ snow15: 1, rain15: 2 })).toBe('snow');
    expect(grip({ rain15: 2 })).toBe('water');
    expect(grip({ rain15: 0.5 })).toBe('wet');
  });

  test('missing fields fire nothing', () => {
    expect(grip({ code: null, tempC: null, rain15: null, snow15: null, isDay: null })).toBeUndefined();
    expect(at(steps(30, () => ({ code: null, tempC: null, rain15: null, precip15: null, snow15: null, visM: null, isDay: null })), 28)).toEqual({});
  });

  test('a burst holds one step; easing takes two easier steps', () => {
    const list = steps(32, (i) => ({ rain15: i === 26 ? 2 : 0 }));
    expect([26, 27, 28].map((i) => gripAt(list, i))).toEqual(['water', 'water', 'wet']);
  });
});

describe('the sight', () => {
  test('the caps: 275 m or less 65 mph, 200 m 55, 140 m 45, 85 m 35', () => {
    expect(SIGHT_BANDS.map((b) => [b.maxM, b.capMph])).toEqual([[85, 35], [140, 45], [200, 55], [275, 65]]);
    expect([276, 275, 201, 200, 141, 140, 86, 85, 10, null].map(sightCapOf)).toEqual([null, 65, 65, 55, 55, 45, 45, 35, 35, null]);
  });

  test('fog must stand for two steps: the clearer of the two reads', () => {
    const two = (now: number | null, before: number | null) => at(steps(30, (i) => ({ visM: i === 28 ? now : i === 27 ? before : 16000 })), 28);
    expect(two(80, 80)).toEqual({ cap: 35 });
    expect(two(150, 190)).toEqual({ cap: 55 });
    expect(two(80, 300)).toEqual({});
    expect(two(80, null)).toEqual({});
    expect(two(null, 80)).toEqual({});
  });

  test('Portland: a single low-visibility step (400 m, fog code; or even 60 m) does nothing at any moment', () => {
    for (const low of [400, 60]) {
      const list = steps(36, (i) => (i === 29 ? { visM: low, code: 45 } : { visM: 12200 }));
      for (let i = 24; i < 36; i += 1) expect(at(list, i)).toEqual({});
    }
  });

  test('grip and sight together', () => {
    expect(at(steps(30, (i) => ({ visM: i >= 27 ? 120 : 16000, rain15: i === 28 ? 0.5 : 0 })), 28)).toEqual({ g: 'wet', cap: 45 });
  });
});

describe('when the state is known', () => {
  const list = steps(36, (i) => ({ rain15: i >= 26 ? 0.5 : 0 }));
  const series: RoadSeries = { lat: LAT, lng: LNG, fetchedAtMs: ms(28), steps: list };

  test('within 90 minutes of the fetch', () => {
    expect(roadStateAt(series, ms(28) + ROAD_STALE_MS, LAT, LNG)).toEqual({ g: 'wet' });
    expect(roadStateAt(series, ms(28) + ROAD_STALE_MS + 1, LAT, LNG)).toBeNull();
    expect(roadStateAt(series, ms(28) - ROAD_STALE_MS - 1, LAT, LNG)).toBeNull();
  });

  test('with 6 hours of steps before the step, none missing', () => {
    expect(ROAD_HISTORY_STEPS).toBe(24);
    expect(at(list, 24)).not.toBeNull();
    expect(at(list, 23)).toBeNull();
    const gap = list.filter((_, i) => i !== 10);
    expect(roadStateAt({ ...series, steps: gap }, ms(28), LAT, LNG)).toBeNull();
    expect(roadStateAt({ ...series, fetchedAtMs: ms(35), steps: gap }, ms(35), LAT, LNG)).toEqual({ g: 'wet' });
    expect(roadStateAt(series, ms(0) - 1, LAT, LNG)).toBeNull();
  });

  test('at the series’ cell or one touching it (0.1° either way), never further', () => {
    expect(at(list, 28, { lat: 47.64, lng: -122.26 })).toEqual({ g: 'wet' });
    expect(at(list, 28, { lat: 47.7, lng: -122.4 })).toEqual({ g: 'wet' });
    expect(at(list, 28, { lat: 47.5, lng: -122.2 })).toEqual({ g: 'wet' });
    expect(at(list, 28, { lat: 47.8 })).toBeNull();
    expect(at(list, 28, { lat: 47.76 })).toBeNull();
    expect(at(list, 28, { lng: -122.5 })).toBeNull();
    expect(at(list, 28, { lat: Number.NaN })).toBeNull();
    expect(inRoadCell({ ...series, lng: 180 }, LAT, -179.9)).toBe(true);
  });

  test('the step a moment falls in: the last at or before it', () => {
    expect(stepIndexAt(list, ms(28))).toBe(28);
    expect(stepIndexAt(list, ms(29) - 1)).toBe(28);
    expect(stepIndexAt(list, ms(0) - 1)).toBe(-1);
  });
});

describe('the road’s words', () => {
  test('titles: grip first, then sight; a wet road at 1 °C or colder is slippery', () => {
    expect(roadTitle({ g: 'ice', cap: 35 }, 5)).toBe('Icy roads');
    expect(roadTitle({ g: 'snow' }, -3)).toBe('Snowy roads');
    expect(roadTitle({ g: 'water' }, 12)).toBe('Heavy rain');
    expect(roadTitle({ g: 'wet' }, 1.1)).toBe('Wet roads');
    expect(roadTitle({ g: 'wet' }, 1)).toBe('Slippery roads');
    expect(roadTitle({ g: 'wet' }, null)).toBe('Wet roads');
    expect(roadTitle({ cap: 55 }, 8)).toBe('Low visibility');
    expect(roadTitle({}, 8)).toBeNull();
    expect(roadTitle(null, 8)).toBeNull();
  });

  test('the title at a moment reads the air of its step', () => {
    const cold = steps(30, (i) => ({ tempC: i === 28 ? 0.5 : 4 }));
    const series: RoadSeries = { lat: LAT, lng: LNG, fetchedAtMs: ms(28), steps: cold };
    expect(roadTitleAt(series, ms(28), { g: 'wet' })).toBe('Slippery roads');
    expect(roadTitleAt(series, ms(27), { g: 'wet' })).toBe('Wet roads');
    expect(roadTitleAt(null, ms(28), { g: 'wet' })).toBe('Wet roads');
  });

  test('the Live Activity kind: the closest alert kind, wet_road for a wet road', () => {
    expect([{ g: 'ice' }, { g: 'snow' }, { g: 'water' }, { g: 'wet' }, { cap: 45 }, {}].map((r) => roadKind(r as RoadStamp))).toEqual([
      'black_ice',
      'snow_on_road',
      'heavy_rain',
      WET_ROAD_KIND,
      'low_visibility',
      null,
    ]);
    expect(WET_ROAD_KIND).toMatch(/^[a-z][a-z_]{0,31}$/);
  });

  test('the quiet line and what a screen reader hears', () => {
    expect(roadCopy.stricter).toBe('Stricter limits now');
    expect(roadSpoken('Wet roads', { g: 'wet' })).toBe('Wet roads. Speeding counts from a lower speed, and hard braking, starts and turns from a lighter touch.');
    expect(roadSpoken('Low visibility', { cap: 45 })).toBe('Low visibility. Speeding counts from a lower speed.');
  });
});
