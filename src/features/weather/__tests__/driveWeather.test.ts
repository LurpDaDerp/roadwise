import { DRIVE_WEATHERS, driveWeatherOf, RAIN_FALLING_MM_H, SNOW_FALLING_CM_H, WMO_RAIN, worseWeather, type DriveWeather } from '../driveWeather';
import type { WeatherReading, WeatherSample } from '../openMeteo';
import { ICE, SNOW_ROAD } from '../thresholds';

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

/** A reading whose current conditions are `now`, with an hour of forecast after it. */
const reading = (now: Partial<WeatherSample>, recentRainMm = 0, recentSnowCm = 0, ahead: Partial<WeatherSample> = {}): WeatherReading => ({
  samples: [sample(now), sample({ time: T + 3600, ...ahead })],
  recentRainMm,
  recentSnowCm,
});
const tag = (now: Partial<WeatherSample>, recentRainMm = 0, recentSnowCm = 0): DriveWeather | null => driveWeatherOf(reading(now, recentRainMm, recentSnowCm));

test('the constants', () => {
  expect(DRIVE_WEATHERS).toEqual(['clear', 'rain', 'snow', 'ice']);
  expect([RAIN_FALLING_MM_H, SNOW_FALLING_CM_H]).toEqual([0.2, 0.1]);
  expect(WMO_RAIN).toEqual([51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 97, 99]);
});

test('no reading: no word (never clear)', () => {
  expect(driveWeatherOf(null)).toBeNull();
});

test.each<[string, Partial<WeatherSample>, number, number]>([
  ['clear and calm', {}, 0, 0],
  ['overcast', { code: 3 }, 0, 0],
  ['fog', { code: 45, visibilityM: 200 }, 0, 0],
  ['a trace of rain under the line', { code: 3, rainMmH: RAIN_FALLING_MM_H - 0.01 }, 0, 0],
  ['wet from earlier rain, mild air', { code: 3 }, 5, 0],
  ['old snow in mild air', { code: 3, tempC: SNOW_ROAD.maxTempC + 0.1 }, 0, 10],
  ['cold and dry', { tempC: -10 }, ICE.wetRoadMm - 0.01, 0],
  ['no temperature, some rain earlier', { tempC: null }, 3, 0],
])('clear: %s', (_name, now, rain, snow) => {
  expect(tag(now, rain, snow)).toBe('clear');
});

test.each<[string, Partial<WeatherSample>]>([
  ['drizzle 51', { code: 51 }],
  ['drizzle 55', { code: 55 }],
  ['rain 61', { code: 61 }],
  ['rain 65', { code: 65 }],
  ['showers 80', { code: 80 }],
  ['showers 82', { code: 82 }],
  ['thunderstorm 95', { code: 95 }],
  ['thunderstorm with hail 99', { code: 99 }],
  ['falling at the line, any code', { code: 3, rainMmH: RAIN_FALLING_MM_H }],
])('rain: %s', (_name, now) => {
  expect(tag(now)).toBe('rain');
});

test.each<[string, Partial<WeatherSample>, number, number]>([
  ['snow 71', { code: 71, tempC: -2 }, 0, 0],
  ['snow showers 86', { code: 86, tempC: -1 }, 0, 0],
  ['snow falling at the line, any code', { code: 3, tempC: 2, snowCmH: SNOW_FALLING_CM_H }, 0, 0],
  ['snow on the road: 2.5 cm in near-freezing air', { code: 3, tempC: SNOW_ROAD.maxTempC }, 0, SNOW_ROAD.snowCm],
  ['snow beats rain', { code: 61, snowCmH: 0.5, tempC: 1 }, 0, 0],
])('snow: %s', (_name, now, rain, snow) => {
  expect(tag(now, rain, snow)).toBe('snow');
});

test.each<[string, Partial<WeatherSample>, number, number]>([
  ['freezing drizzle 56', { code: 56 }, 0, 0],
  ['freezing drizzle 57', { code: 57 }, 0, 0],
  ['freezing rain 66', { code: 66 }, 0, 0],
  ['freezing rain 67', { code: 67 }, 0, 0],
  ['black ice: freezing air on a road wet from the last 3 h', { code: 3, tempC: ICE.freezingC }, ICE.wetRoadMm, 0],
  ['black ice: freezing air with rain falling at the wet line', { code: 3, tempC: -1, rainMmH: ICE.wetRoadMm }, 0, 0],
  ['ice beats snow', { code: 71, tempC: -3 }, 2, 5],
])('ice: %s', (_name, now, rain, snow) => {
  expect(tag(now, rain, snow)).toBe('ice');
});

test('the forecast never counts: rain, snow or freezing rain ahead leaves a clear now clear', () => {
  for (const ahead of [{ code: 65, rainMmH: 9 }, { code: 75, snowCmH: 3 }, { code: 67 }]) {
    expect(driveWeatherOf(reading({}, 0, 0, ahead))).toBe('clear');
  }
});

test('a reading with no samples reads from its sums alone', () => {
  expect(driveWeatherOf({ samples: [], recentRainMm: 0, recentSnowCm: 0 })).toBe('clear');
  // No temperature: neither ice nor snow on the road can be judged.
  expect(driveWeatherOf({ samples: [], recentRainMm: 5, recentSnowCm: 9 })).toBe('clear');
});

test('worseWeather: ice, then snow, then rain, then clear, then none; either order', () => {
  const order: (DriveWeather | null)[] = [null, 'clear', 'rain', 'snow', 'ice'];
  for (const [i, a] of order.entries()) {
    for (const [j, b] of order.entries()) {
      const want = order[Math.max(i, j)];
      expect(worseWeather(a, b)).toBe(want);
    }
  }
});
