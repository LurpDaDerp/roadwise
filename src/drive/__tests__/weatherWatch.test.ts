import type { DangerAlert } from '@/features/weather/danger';
import type { DriveWeather } from '@/features/weather/driveWeather';
import type { WeatherReading, WeatherSample } from '@/features/weather/openMeteo';
import { createWeatherWatch, WEATHER_REFETCH_DISTANCE_M, WEATHER_REFRESH_MS } from '@/drive/weatherWatch';

const rain: DangerAlert = { kind: 'heavy_rain', gustMph: null, visibilityM: null };
const fog: DangerAlert = { kind: 'dense_fog', gustMph: null, visibilityM: 150 };
const flush = () => new Promise((r) => setTimeout(r, 0));
const fix = (lat = 47.6, lng = -122.3) => ({ gnssValid: true, lat, lng });

function rig(answers: (DangerAlert | null | Error)[]) {
  let now = 1_000_000;
  const asked: [number, number][] = [];
  const told: (DangerAlert | null)[] = [];
  const watch = createWeatherWatch({
    now: () => now,
    lookup: async (lat, lng) => {
      asked.push([lat, lng]);
      const a = answers.shift() ?? null;
      if (a instanceof Error) throw a;
      return a;
    },
    lastPosition: async () => ({ lat: 1, lng: 2 }),
    onAlert: (a) => told.push(a),
  });
  return { watch, asked, told, advance: (ms: number) => (now += ms) };
}

test('checks once at the start (the cached position before any fix), then every 15 min of rows, never faster', async () => {
  const r = rig([rain, null, fog]);
  await flush();
  expect(r.asked).toEqual([[1, 2]]);
  expect(r.told).toEqual([rain]);
  for (let s = 1; s < 900; s += 1) {
    r.advance(1000);
    r.watch.onRow(fix(), s * 10);
  }
  await flush();
  expect(r.asked).toHaveLength(1);
  r.advance(1000);
  r.watch.onRow(fix(), 9000);
  await flush();
  expect(r.asked).toEqual([[1, 2], [47.6, -122.3]]);
  expect(r.told).toEqual([rain, null]);
  expect(WEATHER_REFRESH_MS).toBe(900_000);
});

test('again after each 20 km of the odometer, from the drive’s own latest fix', async () => {
  const r = rig([null, fog]);
  await flush();
  r.advance(60_000);
  r.watch.onRow(fix(48, -121), WEATHER_REFETCH_DISTANCE_M - 1);
  await flush();
  expect(r.asked).toHaveLength(1);
  r.watch.onRow(fix(48.1, -121), WEATHER_REFETCH_DISTANCE_M);
  await flush();
  expect(r.asked.at(-1)).toEqual([48.1, -121]);
  expect(r.told.at(-1)).toEqual(fog);
});

test('a failing lookup is "no alert"; a stopped watch asks and tells nothing more', async () => {
  const r = rig([new Error('offline'), rain]);
  await flush();
  expect(r.told).toEqual([null]);
  r.watch.stop();
  r.advance(WEATHER_REFRESH_MS);
  r.watch.onRow(fix(), 0);
  await flush();
  expect(r.asked).toHaveLength(1);
  expect(r.told).toEqual([null]);
});

describe('the drive weather tag', () => {
  const sample = (over: Partial<WeatherSample> = {}): WeatherSample => ({
    time: 0,
    code: 3,
    tempC: 8,
    rainMmH: 0,
    precipMmH: 0,
    snowCmH: 0,
    windMph: 5,
    gustMph: 8,
    visibilityM: 16000,
    isDay: true,
    ...over,
  });
  const reading = (now: Partial<WeatherSample>, later: Partial<WeatherSample> = {}): WeatherReading => ({
    samples: [sample(now), sample(later)],
    recentRainMm: 0,
    recentSnowCm: 0,
  });

  function readRig(answers: (WeatherReading | null | Error)[]) {
    let now = 1_000_000;
    const order: string[] = [];
    const tags: DriveWeather[] = [];
    const told: (DangerAlert | null)[] = [];
    const watch = createWeatherWatch({
      now: () => now,
      read: async () => {
        const a = answers.shift() ?? null;
        if (a instanceof Error) throw a;
        return a;
      },
      lastPosition: async () => ({ lat: 1, lng: 2 }),
      onTag: (t) => (tags.push(t), order.push(`tag:${t}`)),
      onAlert: (a) => (told.push(a), order.push(`alert:${a?.kind ?? 'none'}`)),
    });
    return { watch, tags, told, order, advance: (ms: number) => (now += ms) };
  }

  test('one reading feeds both: the tag from the conditions now (never the forecast), then the alert from now and ahead', async () => {
    // Light rain now; heavy rain in an hour: tagged rain, alerted heavy rain.
    const r = readRig([reading({ code: 61, rainMmH: 1 }, { code: 65, rainMmH: 9 })]);
    await flush();
    expect(r.order).toEqual(['tag:rain', 'alert:heavy_rain']);
  });

  test('every reading tags (clear included); a failed or empty check tags nothing and is no alert', async () => {
    const r = readRig([reading({}), null]);
    await flush();
    expect(r.tags).toEqual(['clear']);
    expect(r.told).toEqual([null]);
    r.advance(WEATHER_REFRESH_MS);
    r.watch.onRow(fix(), 0);
    await flush();
    expect(r.tags).toEqual(['clear']);
    expect(r.told).toEqual([null, null]);
    const failing = readRig([new Error('offline')]);
    await flush();
    expect(failing.tags).toEqual([]);
    expect(failing.told).toEqual([null]);
  });

  test('a stopped watch tags nothing; an alert-only lookup tags nothing; a throwing onTag still lets the alert out', async () => {
    const r = readRig([reading({ code: 71 })]);
    r.watch.stop();
    await flush();
    expect(r.order).toEqual([]);
    const alertOnly = rig([rain]);
    await flush();
    expect(alertOnly.told).toEqual([rain]);
    const told: (DangerAlert | null)[] = [];
    createWeatherWatch({
      now: () => 0,
      read: async () => reading({ code: 66 }),
      lastPosition: async () => ({ lat: 1, lng: 2 }),
      onTag: () => {
        throw new Error('db');
      },
      onAlert: (a) => told.push(a),
    });
    await flush();
    expect(told.map((a) => a?.kind)).toEqual(['freezing_rain']);
  });
});
