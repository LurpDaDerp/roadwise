import { KMH_PER_MPH } from '@/lib/units';

import { WEATHER_ACTIONS, WEATHER_TITLES, weatherAction, weatherLabel, weatherLine, weatherTitle } from '../copy';
import { DANGER_ORDER, dangerAt, dangerFrom, isDangerKind, moreSevere, type DangerAlert, type DangerKind } from '../danger';
import type { WeatherReading, WeatherSample } from '../openMeteo';
import { ICE, NIGHT_RAIN, QUARTER_MILE_M, RATE, SNOW_ROAD, STANDING_WATER, WIND } from '../thresholds';

const T = 1_790_000_000;

/** A calm, mild, clear moment by day; each test changes only what it is about. */
function sample(over: Partial<WeatherSample> = {}): WeatherSample {
  return {
    time: T,
    code: 0,
    tempC: 12,
    rainMmH: 0,
    precipMmH: 0,
    snowCmH: 0,
    windMph: 5,
    gustMph: 10,
    visibilityM: 20_000,
    isDay: true,
    ...over,
  };
}

const at = (over: Partial<WeatherSample>, recentRainMm = 0, recentSnowCm = 0): DangerKind | null =>
  dangerAt(sample(over), recentRainMm, recentSnowCm);
const reading = (samples: WeatherSample[], recentRainMm = 0, recentSnowCm = 0): WeatherReading => ({ samples, recentRainMm, recentSnowCm });

describe('nothing dangerous: no alert', () => {
  test.each<[string, Partial<WeatherSample>]>([
    ['clear and calm', {}],
    ['overcast', { code: 3 }],
    ['light rain', { code: 61, rainMmH: 1.2, precipMmH: 1.2 }],
    ['moderate rain just under heavy', { code: 63, rainMmH: RATE.heavyRainMmH - 0.1, precipMmH: RATE.heavyRainMmH - 0.1 }],
    ['light snow, good visibility', { code: 71, snowCmH: 0.4, tempC: -2, visibilityM: 3000 }],
    ['a breezy day just under a Wind Advisory', { windMph: 25, gustMph: WIND.advisoryGustMph - 0.1 }],
    ['mist with fair visibility', { code: 45, visibilityM: 1500 }],
    ['cold and dry', { tempC: -12 }],
    ['every field unknown', { code: null, tempC: null, rainMmH: null, precipMmH: null, snowCmH: null, windMph: null, gustMph: null, visibilityM: null, isDay: null }],
    ['a drizzle at night', { code: 51, rainMmH: 0.4, precipMmH: 0.4, isDay: false }],
    ['light rain at night, just under moderate', { code: 61, rainMmH: NIGHT_RAIN.rainMmH - 0.1, precipMmH: NIGHT_RAIN.rainMmH - 0.1, isDay: false }],
    ['moderate rain by day', { code: 63, rainMmH: 5, precipMmH: 5 }],
    ['a thunderstorm with only a sprinkle', { code: 95, rainMmH: 1, precipMmH: 1 }],
    ['rime fog that can still be seen through', { code: 48, tempC: -2, visibilityM: 2000 }],
  ])('%s', (_name, over) => {
    expect(at(over)).toBeNull();
  });

  test('a wet road by day after a modest rain: no alert', () => {
    expect(at({ code: 3 }, STANDING_WATER.rainMm - 0.1)).toBeNull();
    expect(at({ code: 61, rainMmH: 1.5, precipMmH: 1.5 }, 8)).toBeNull();
  });

  test('a dusting of snow, or snow that has had time to melt: no alert', () => {
    expect(at({ tempC: -3 }, 0, SNOW_ROAD.snowCm - 0.1)).toBeNull();
    expect(at({ tempC: SNOW_ROAD.maxTempC + 0.1 }, 0, 6)).toBeNull();
  });
});

describe('each danger at its cited threshold (and not just below it)', () => {
  test('freezing rain and freezing drizzle: any (WMO 66/67, 56/57)', () => {
    expect(at({ code: 66 })).toBe('freezing_rain');
    expect(at({ code: 67 })).toBe('freezing_rain');
    expect(at({ code: 56 })).toBe('freezing_drizzle');
    expect(at({ code: 57 })).toBe('freezing_drizzle');
  });

  test('thunderstorm (WMO 95/97) with at least moderate rain (2.6 mm an hour); hail (WMO 96/99)', () => {
    expect(at({ code: 95, rainMmH: RATE.moderateRainMmH })).toBe('thunderstorm');
    expect(at({ code: 97, rainMmH: 4 })).toBe('thunderstorm');
    expect(at({ code: 95, rainMmH: RATE.moderateRainMmH - 0.01 })).toBeNull();
    expect(at({ code: 95, rainMmH: null })).toBeNull();
    expect(at({ code: 96 })).toBe('hail');
    expect(at({ code: 99 })).toBe('hail');
  });

  test('heavy rain: 7.6 mm an hour (AMS "heavy": over 0.30 in an hour)', () => {
    expect(at({ rainMmH: RATE.heavyRainMmH })).toBe('heavy_rain');
    expect(at({ rainMmH: RATE.heavyRainMmH - 0.01 })).toBeNull();
  });

  test('heavy snow: 2.5 cm (1 in) an hour, or snow cutting visibility to 1/4 mile', () => {
    expect(at({ code: 73, tempC: -3, snowCmH: RATE.heavySnowCmH })).toBe('heavy_snow');
    expect(at({ code: 73, tempC: -3, snowCmH: RATE.heavySnowCmH - 0.01 })).toBeNull();
    expect(at({ code: 71, tempC: -3, snowCmH: 0.5, visibilityM: QUARTER_MILE_M })).toBe('heavy_snow');
    expect(at({ code: 71, tempC: -3, snowCmH: 0.5, visibilityM: QUARTER_MILE_M + 1 })).toBeNull();
  });

  test('blizzard: snow, visibility 1/4 mile or less, and wind or gusts of 35 mph or more', () => {
    const snow = { code: 75, tempC: -8, snowCmH: 1, visibilityM: QUARTER_MILE_M };
    expect(at({ ...snow, gustMph: WIND.blizzardMph })).toBe('blizzard');
    expect(at({ ...snow, windMph: WIND.blizzardMph, gustMph: null })).toBe('blizzard');
    // Just under the wind: heavy snow, not a blizzard.
    expect(at({ ...snow, gustMph: WIND.blizzardMph - 0.1 })).toBe('heavy_snow');
    // Wind and snow, but the road can still be seen: not a blizzard.
    expect(at({ ...snow, visibilityM: QUARTER_MILE_M + 1, gustMph: 40 })).toBeNull();
  });

  test('strong winds at the Wind Advisory gust (46 mph); high winds at the High Wind Warning (gusts 58, sustained 40)', () => {
    expect(at({ gustMph: WIND.advisoryGustMph })).toBe('strong_wind');
    expect(at({ gustMph: WIND.warningGustMph - 0.1 })).toBe('strong_wind');
    expect(at({ gustMph: WIND.warningGustMph })).toBe('high_wind');
    expect(at({ windMph: WIND.warningSustainedMph, gustMph: 45 })).toBe('high_wind');
    expect(at({ windMph: WIND.warningSustainedMph - 0.1, gustMph: 45 })).toBeNull();
  });

  test('dense fog: fog with visibility 1/4 mile (402 m) or less', () => {
    expect(at({ code: 45, visibilityM: QUARTER_MILE_M })).toBe('dense_fog');
    expect(at({ code: 45, visibilityM: QUARTER_MILE_M + 1 })).toBeNull();
    // No fog code, but nothing falling: still fog.
    expect(at({ code: 3, visibilityM: 150 })).toBe('dense_fog');
  });

  test('low visibility: under 1/4 mile in rain that is not itself heavy', () => {
    expect(at({ code: 61, rainMmH: 2, precipMmH: 2, visibilityM: 300 })).toBe('low_visibility');
  });

  test('freezing fog: fog cutting visibility to 1/4 mile at or below 0 °C (rime fog when the temperature is unknown)', () => {
    expect(at({ code: 48, tempC: 0, visibilityM: QUARTER_MILE_M })).toBe('freezing_fog');
    expect(at({ code: 48, tempC: null, visibilityM: 300 })).toBe('freezing_fog');
    expect(at({ code: 48, tempC: 0, visibilityM: QUARTER_MILE_M + 1 })).toBeNull();
    expect(at({ code: 48, tempC: 0, visibilityM: null })).toBeNull();
    expect(at({ code: 48, tempC: 1, visibilityM: 200 })).toBe('dense_fog');
    expect(at({ code: 45, tempC: -1, visibilityM: 200 })).toBe('freezing_fog');
    // Fog below freezing that can still be seen through: no alert.
    expect(at({ code: 45, tempC: -1, visibilityM: 2000 })).toBeNull();
  });

  test('black ice: at or below 0 °C after 0.5 mm of rain in the last 3 hours (or rain now)', () => {
    expect(at({ tempC: ICE.freezingC }, ICE.wetRoadMm)).toBe('black_ice');
    expect(at({ tempC: ICE.freezingC }, ICE.wetRoadMm - 0.01)).toBeNull();
    expect(at({ tempC: ICE.freezingC + 0.1 }, 5)).toBeNull();
    expect(at({ tempC: -1, rainMmH: ICE.wetRoadMm })).toBe('black_ice');
  });

  test('rain at night: moderate rain (2.6 mm an hour) or more after dark', () => {
    expect(at({ code: 63, rainMmH: NIGHT_RAIN.rainMmH, precipMmH: NIGHT_RAIN.rainMmH, isDay: false })).toBe('rain_at_night');
    expect(at({ code: 80, rainMmH: 5, isDay: false })).toBe('rain_at_night');
    // The same rain by day, or when day and night are unknown: no alert.
    expect(at({ code: 63, rainMmH: 5, isDay: true })).toBeNull();
    expect(at({ code: 63, rainMmH: 5, isDay: null })).toBeNull();
    // Heavier rain at night is heavy rain.
    expect(at({ rainMmH: RATE.heavyRainMmH, isDay: false })).toBe('heavy_rain');
  });

  test('standing water: 19 mm (0.75 in) of rain in the last 3 hours, even once it has eased', () => {
    expect(STANDING_WATER).toEqual({ rainMm: 19, lookbackHours: 3 });
    expect(at({ code: 3 }, STANDING_WATER.rainMm)).toBe('standing_water');
    expect(at({ code: 3 }, STANDING_WATER.rainMm - 0.01)).toBeNull();
    // Still pouring: heavy rain names it; below freezing: black ice.
    expect(at({ rainMmH: 12 }, 30)).toBe('heavy_rain');
    expect(at({ tempC: -1 }, 30)).toBe('black_ice');
    // At night it outranks rain at night.
    expect(at({ rainMmH: 4, isDay: false }, 25)).toBe('standing_water');
  });

  test('snow on the road: 2.5 cm (1 in) of snow in the last 6 hours, air at or below 1 °C', () => {
    expect(SNOW_ROAD).toEqual({ snowCm: 2.5, maxTempC: 1, lookbackHours: 6 });
    expect(at({ tempC: SNOW_ROAD.maxTempC }, 0, SNOW_ROAD.snowCm)).toBe('snow_on_road');
    expect(at({ tempC: -6, code: 71, snowCmH: 0.3 }, 0, 4)).toBe('snow_on_road');
    expect(at({ tempC: null }, 0, 10)).toBeNull();
    // Still falling hard: heavy snow names it.
    expect(at({ tempC: -3, code: 75, snowCmH: 3 }, 0, 8)).toBe('heavy_snow');
  });
});

describe('the most severe wins', () => {
  test('the order: blizzard first, rain at night last', () => {
    expect(DANGER_ORDER[0]).toBe('blizzard');
    expect(DANGER_ORDER.at(-1)).toBe('rain_at_night');
    expect(DANGER_ORDER.slice(DANGER_ORDER.indexOf('heavy_snow'))).toEqual([
      'heavy_snow',
      'snow_on_road',
      'freezing_fog',
      'dense_fog',
      'low_visibility',
      'thunderstorm',
      'heavy_rain',
      'standing_water',
      'strong_wind',
      'rain_at_night',
    ]);
    expect(moreSevere('freezing_rain', 'heavy_rain')).toBe(true);
    expect(moreSevere('heavy_rain', 'freezing_rain')).toBe(false);
    expect(moreSevere('strong_wind', null)).toBe(true);
  });

  test('in one moment: freezing rain with strong gusts names the ice', () => {
    expect(at({ code: 66, gustMph: 50, tempC: -1 })).toBe('freezing_rain');
    expect(at({ code: 95, gustMph: 60 })).toBe('high_wind');
    expect(at({ code: 95, rainMmH: 20 })).toBe('thunderstorm');
  });

  test('across now and the next 2 hours: a later, worse danger beats a milder one now', () => {
    const r = reading([sample({ gustMph: 48 }), sample({ time: T + 3600, gustMph: 52 }), sample({ time: T + 7200, code: 67, tempC: -1 })]);
    expect(dangerFrom(r)).toEqual<DangerAlert>({ kind: 'freezing_rain', gustMph: null, visibilityM: null });
  });

  test('the wind alert carries the strongest gust, the fog alert the lowest visibility', () => {
    expect(
      dangerFrom(reading([sample({ gustMph: 48 }), sample({ time: T + 3600, gustMph: 55.6 })]))
    ).toEqual({ kind: 'strong_wind', gustMph: 55.6, visibilityM: null });
    expect(
      dangerFrom(reading([sample({ code: 45, visibilityM: 300 }), sample({ time: T + 3600, code: 45, visibilityM: 120 })]))
    ).toEqual({ kind: 'dense_fog', gustMph: null, visibilityM: 120 });
  });

  test('no reading, or nothing dangerous in it: null', () => {
    expect(dangerFrom(null)).toBeNull();
    expect(dangerFrom(reading([sample(), sample({ time: T + 3600 })]))).toBeNull();
    expect(dangerFrom(reading([], 30, 10))).toBeNull();
  });

  test('the reading carries the recent snow and rain to every moment', () => {
    expect(dangerFrom(reading([sample({ tempC: -2 }), sample({ time: T + 3600, tempC: -1 })], 0, 3))).toEqual({
      kind: 'snow_on_road',
      gustMph: null,
      visibilityM: null,
    });
    expect(dangerFrom(reading([sample(), sample({ time: T + 3600, rainMmH: 4, isDay: false })], 20))?.kind).toBe('standing_water');
    expect(dangerFrom(reading([sample(), sample({ time: T + 3600, rainMmH: 4, isDay: false })]))?.kind).toBe('rain_at_night');
  });

  test('isDangerKind guards a stored value', () => {
    expect(isDangerKind('dense_fog')).toBe(true);
    expect(isDangerKind('rain_at_night')).toBe(true);
    expect(isDangerKind('standing_water')).toBe(true);
    expect(isDangerKind('snow_on_road')).toBe(true);
    expect(isDangerKind('tornado')).toBe(false);
    expect(isDangerKind(null)).toBe(false);
  });
});

describe('the words', () => {
  const alert = (kind: DangerKind, over: Partial<DangerAlert> = {}): DangerAlert => ({ kind, gustMph: null, visibilityM: null, ...over });

  test('every title is one to three words; every line is about 60 characters at most, with no "!" or em dash', () => {
    for (const kind of DANGER_ORDER) {
      expect(WEATHER_TITLES[kind].split(' ').length).toBeLessThanOrEqual(3);
      for (const a of [alert(kind), alert(kind, { gustMph: 63, visibilityM: 180 })]) {
        for (const units of ['mi', 'km'] as const) {
          const line = weatherLine(a, units);
          expect(line.length).toBeLessThanOrEqual(60);
          expect(line).not.toMatch(/[!—]/);
        }
      }
    }
  });

  test('every warning is four words at most, with no end stop, and agrees with its line', () => {
    for (const kind of DANGER_ORDER) {
      const action = WEATHER_ACTIONS[kind];
      expect(action.split(' ').length).toBeLessThanOrEqual(4);
      expect(action).not.toMatch(/[.!—]$/);
      expect(weatherAction(alert(kind))).toBe(action);
    }
    expect(weatherAction(alert('blizzard'))).toBe('Stay off the road');
    expect(weatherAction(alert('black_ice'))).toBe('Slow down, brake gently');
    expect(weatherLine(alert('freezing_rain'), 'mi')).toContain(weatherAction(alert('freezing_rain')));
    expect(weatherLine(alert('dense_fog'), 'mi')).toContain(weatherAction(alert('dense_fog')));
    expect(weatherLine(alert('strong_wind'), 'mi')).toContain(weatherAction(alert('strong_wind')).toLowerCase());
    for (const kind of ['snow_on_road', 'standing_water', 'rain_at_night'] as const) {
      expect(weatherLine(alert(kind), 'mi')).toContain(weatherAction(alert(kind)));
    }
  });

  test('the new dangers read plainly', () => {
    expect([weatherTitle(alert('rain_at_night')), weatherLine(alert('rain_at_night'), 'mi')]).toEqual([
      'Rain at night',
      'Rain at night hides the lane lines. Slow down, leave room.',
    ]);
    expect([weatherTitle(alert('standing_water')), weatherLine(alert('standing_water'), 'km')]).toEqual([
      'Standing water',
      'Water is pooling on the road. Slow down, avoid puddles.',
    ]);
    expect([weatherTitle(alert('snow_on_road')), weatherLine(alert('snow_on_road'), 'mi')]).toEqual([
      'Snowy roads',
      'Fresh snow on the road. Slow down, brake gently.',
    ]);
  });

  test('wind in the driver units', () => {
    expect(weatherLine(alert('strong_wind', { gustMph: 52.4 }), 'mi')).toBe('Gusts to 52 mph. Keep both hands on the wheel.');
    expect(weatherLine(alert('high_wind', { gustMph: 60 }), 'km')).toBe(`Gusts to ${Math.round(60 * KMH_PER_MPH)} km/h. Keep both hands on the wheel.`);
  });

  test('visibility in feet or metres, to the nearest 50', () => {
    expect(weatherLine(alert('dense_fog', { visibilityM: 200 }), 'mi')).toBe('Visibility 650 ft. Slow down, low beams on.');
    expect(weatherLine(alert('dense_fog', { visibilityM: 180 }), 'km')).toBe('Visibility 200 m. Slow down, low beams on.');
    expect(weatherLine(alert('dense_fog', { visibilityM: 5 }), 'km')).toBe('Visibility 50 m. Slow down, low beams on.');
  });

  test('the spoken label carries the title and the line', () => {
    const a = alert('freezing_rain');
    expect(weatherTitle(a)).toBe('Freezing rain');
    expect(weatherLabel(a, 'mi')).toBe('Weather alert. Freezing rain. Rain is freezing on the road. Slow down, brake gently.');
  });
});
