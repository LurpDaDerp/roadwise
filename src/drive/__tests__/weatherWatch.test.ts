import type { DangerAlert } from '@/features/weather/danger';
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
