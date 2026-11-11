import { createSettingsRepo, migrate } from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { DangerAlert } from '@/features/weather/danger';
import type { DriveWeather } from '@/features/weather/driveWeather';
import type { FetchLike, WeatherReading, WeatherSample } from '@/features/weather/openMeteo';
import { parseRoadSeries, reviveSeries, roadSeriesUrl } from '@/features/weather/roadSeries';
import { answer, NOW, seriesBody, type StepValues } from '@/features/weather/__fixtures__/roadSeries';
import {
  createWeatherWatch,
  WEATHER_HOLD_KEY,
  WEATHER_REFETCH_DISTANCE_M,
  WEATHER_REFRESH_MS,
  weatherHoldIn,
  type WeatherHold,
} from '@/drive/weatherWatch';

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

describe('the series watch', () => {
  const HOME = { lat: 47.6, lng: -122.3 };
  const MIN = 60_000;
  const START = NOW * 1000;
  /** The fake fetch answers at once: a few microtasks carry an answer through (no timer, so rows run fast). */
  const settle = async () => {
    for (let k = 0; k < 20; k += 1) await Promise.resolve();
  };

  /** The cell a request asked for. */
  const cellOf = (url: string) => {
    const u = new URL(url);
    return { lat: Number(u.searchParams.get('latitude')), lng: Number(u.searchParams.get('longitude')) };
  };

  function seriesRig(
    opts: {
      respond?: (n: number) => Response | Error;
      weather?: (t: number) => StepValues;
      hold?: WeatherHold;
      position?: { lat: number; lng: number } | null;
      start?: number;
    } = {}
  ) {
    let now = opts.start ?? START;
    const urls: string[] = [];
    const sent: number[] = [];
    const order: string[] = [];
    const told: (DangerAlert | null)[] = [];
    const ok = () => answer(seriesBody(Math.floor(now / 1000), (t) => opts.weather?.(t) ?? {}));
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      sent.push(now);
      const r = opts.respond ? opts.respond(urls.length) : ok();
      if (r instanceof Error) throw r;
      return r;
    };
    const watch = createWeatherWatch({
      now: () => now,
      fetch,
      hold: opts.hold,
      lastPosition: async () => (opts.position === undefined ? HOME : opts.position),
      onTag: (t) => order.push(`tag:${t}`),
      onAlert: (a) => (told.push(a), order.push(`alert:${a?.kind ?? 'none'}`)),
    });
    /** Rows every `everyMs` from now until `untilMs` after the start, at `where(t)`. */
    async function drive(untilMs: number, where: (t: number) => { lat: number; lng: number } = () => HOME, everyMs = 10_000) {
      while (now + everyMs <= START + untilMs) {
        now += everyMs;
        watch.onRow({ gnssValid: true, ...where(now) }, 0);
        await settle();
      }
    }
    const minutes = () => sent.map((t) => (t - START) / MIN);
    return { watch, urls, sent, order, told, ok, drive, minutes, now: () => now };
  }

  test('one request as the drive opens, from the cached position: the tag, then the alert, from the step now', async () => {
    const r = seriesRig({ position: { lat: 1.04, lng: 2.02 }, weather: (t) => (t === NOW ? { weather_code: 61, rain: 0.3 } : {}) });
    await flush();
    expect(r.urls).toEqual([roadSeriesUrl(1, 2)]);
    expect(r.order).toEqual(['tag:rain', 'alert:none']);
    expect(r.watch.roadAt(r.now(), 1, 2)).toEqual({});
  });

  test('a new cell asks for its own answer, never within 5 min; meanwhile the touching cell’s answer stands', async () => {
    const r = seriesRig();
    await flush();
    const next = { lat: 47.7, lng: -122.3 };
    await r.drive(5 * MIN - 10_000, () => next);
    expect(r.urls).toHaveLength(1);
    expect(r.watch.roadAt(r.now(), next.lat, next.lng)).toEqual({});
    await r.drive(5 * MIN, () => next);
    expect(r.urls.map(cellOf)).toEqual([HOME, next]);
    // A cell two away from every held answer is unknown: no road state.
    expect(r.watch.roadAt(r.now(), 47.9, -122.3)).toBeNull();
  });

  test('the same cell asks again when its answer is 30 min old (the model updates hourly)', async () => {
    const r = seriesRig();
    await flush();
    await r.drive(61 * MIN);
    expect(r.minutes()).toEqual([0, 30, 60]);
  });

  test('a car weaving along a cell border re-reads the cells it holds and sends nothing new', async () => {
    const r = seriesRig();
    await flush();
    const other = { lat: 47.6, lng: -122.2 };
    await r.drive(5 * MIN, () => other);
    expect(r.urls).toHaveLength(2);
    await r.drive(29 * MIN, (t) => (Math.floor(t / 20_000) % 2 === 0 ? HOME : other));
    expect(r.urls).toHaveLength(2);
  });

  test('a fix jittering across a cell border keeps the alert: the judged answer stands while it serves and nothing newer serves the cell', async () => {
    // The home cell's answer has heavy rain (an alert); the cell beside it, answered 5 min later, has none.
    const other = { lat: 47.6, lng: -122.2 };
    const r = seriesRig({
      respond: (n) => answer(seriesBody(Math.floor(r.now() / 1000), () => (n === 1 ? { weather_code: 65, rain: 2, precipitation: 2 } : {}))),
    });
    await flush();
    expect(r.order).toEqual(['tag:rain', 'alert:heavy_rain']);
    await r.drive(5 * MIN, () => other);
    expect(r.urls.map(cellOf)).toEqual([HOME, other]);
    // The newer answer for the car's cell takes over.
    expect(r.order.slice(2)).toEqual(['tag:clear', 'alert:none']);
    await r.drive(14 * MIN, (t) => (Math.floor(t / 10_000) % 2 === 0 ? HOME : other), 1000);
    expect(r.order.slice(4)).toEqual([]);
    expect(r.urls).toHaveLength(2);
  });

  test('the road state follows the step of a held answer, read back and forth', async () => {
    // A downpour in the step 15 min on only: water from then, held a step, then the film it left is wet.
    const r = seriesRig({ weather: (t) => (t === NOW + 900 ? { weather_code: 65, rain: 2, precipitation: 2 } : {}) });
    await flush();
    const at = (min: number) => r.watch.roadAt(START + min * MIN, HOME.lat, HOME.lng);
    expect([at(5), at(20), at(5), at(35), at(35), at(50), at(20)]).toEqual([{}, { g: 'water' }, {}, { g: 'water' }, { g: 'water' }, { g: 'wet' }, { g: 'water' }]);
    expect(r.watch.roadAt(START + 20 * MIN, 47.9, -122.3)).toBeNull();
  });

  test('failures wait 1, 2, 4, 8, then 15 min; an answer resets the waits; nothing serving is no alert', async () => {
    let failing = true;
    const r = seriesRig({ respond: () => (failing ? answer({ error: true }, 503) : r.ok()) });
    await flush();
    await r.drive(50 * MIN);
    expect(r.minutes()).toEqual([0, 1, 3, 7, 15, 30, 45]);
    expect(r.order).toEqual(Array.from({ length: 7 }, () => 'alert:none'));
    failing = false;
    await r.drive(60 * MIN);
    expect(r.minutes().slice(7)).toEqual([60]);
    failing = true;
    await r.drive(92 * MIN);
    expect(r.minutes().slice(8)).toEqual([90, 91]);
  });

  test('429: the larger of Retry-After and 15 min, doubling to 60', async () => {
    const bare = seriesRig({ respond: () => answer({ error: true }, 429) });
    await flush();
    await bare.drive(170 * MIN, undefined, 30_000);
    expect(bare.minutes()).toEqual([0, 15, 45, 105, 165]);

    const long = seriesRig({ respond: () => answer({ error: true }, 429, { 'Retry-After': '1800' }) });
    await flush();
    await long.drive(121 * MIN, undefined, 30_000);
    expect(long.minutes()).toEqual([0, 30, 60, 120]);

    const short = seriesRig({ respond: () => answer({ error: true }, 429, { 'Retry-After': '60' }) });
    await flush();
    await short.drive(16 * MIN, undefined, 30_000);
    expect(short.minutes()).toEqual([0, 15]);
  });

  test('offline, the held answer serves until it is 90 min old, then the weather is unknown', async () => {
    const r = seriesRig({
      weather: () => ({ weather_code: 61, rain: 0.25 }),
      respond: (n) => (n === 1 ? r.ok() : new Error('offline')),
    });
    await flush();
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toEqual({ g: 'wet' });
    await r.drive(90 * MIN, undefined, 30_000);
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toEqual({ g: 'wet' });
    expect(r.order.slice(-2)).toEqual(['tag:rain', 'alert:none']);
    const tags = r.order.filter((o) => o.startsWith('tag')).length;
    await r.drive(90 * MIN + 30_000, undefined, 30_000);
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toBeNull();
    await r.drive(120 * MIN, undefined, 30_000);
    expect(r.order.filter((o) => o.startsWith('tag')).length).toBe(tags);
    expect(r.told.at(-1)).toBeNull();
  });

  test('each 15-minute step is judged again from the held answer, with no request', async () => {
    // A downpour in the step 15 min on only: no alert ahead (the hour it falls in is light), heavy rain then.
    // The drive opens 5 min into a step, so the cell's 30-min refresh falls between steps.
    const r = seriesRig({ start: START + 5 * MIN, weather: (t) => (t === NOW + 900 ? { weather_code: 65, rain: 2, precipitation: 2 } : {}) });
    await flush();
    expect(r.order).toEqual(['tag:clear', 'alert:none']);
    await r.drive(14 * MIN + 50_000);
    expect(r.order).toHaveLength(2);
    await r.drive(15 * MIN);
    expect(r.order.slice(2)).toEqual(['tag:rain', 'alert:heavy_rain']);
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toEqual({ g: 'water' });
    await r.drive(30 * MIN - 10_000);
    expect(r.order.slice(4)).toEqual([]);
    await r.drive(30 * MIN);
    expect(r.order.slice(4)).toEqual(['tag:clear', 'alert:none']);
    // The burst holds a step.
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toEqual({ g: 'water' });
    expect(r.urls).toHaveLength(1);
  });

  test('a 12-hour freeway drive (70 mph, a new cell every few minutes) sends at most 144 requests and is rarely unknown', async () => {
    const r = seriesRig();
    await flush();
    const v = 31.3;
    const where = (t: number) => {
      const s = ((t - START) / 1000) * v * Math.SQRT1_2;
      const lat = HOME.lat + s / 111_320;
      return { lat, lng: HOME.lng + s / (111_320 * Math.cos((lat * Math.PI) / 180)) };
    };
    let unknown = 0;
    // Requests at 0, 5, … 715 min at most.
    await r.drive(
      12 * 60 * MIN - 15_000,
      (t) => {
        const p = where(t);
        if (r.watch.roadAt(t, p.lat, p.lng) === null) unknown += 1;
        return p;
      },
      15_000
    );
    expect(r.urls.length).toBeLessThanOrEqual(144);
    expect(r.urls.length).toBeGreaterThan(100);
    // Heading north-east into narrower cells, the car sometimes reaches a cell two from its newest
    // answer a little before the 5 min are up: unknown (the normal lines) until the next answer.
    expect(unknown / (12 * 60 * 4)).toBeLessThan(0.02);
    for (let k = 1; k < r.sent.length; k += 1) expect((r.sent[k] ?? 0) - (r.sent[k - 1] ?? 0)).toBeGreaterThanOrEqual(5 * MIN);
  });

  test('the last 6 cells are held: a seventh drops the oldest', async () => {
    const r = seriesRig();
    await flush();
    const cell = (k: number) => ({ lat: HOME.lat + k, lng: HOME.lng });
    for (let k = 1; k <= 6; k += 1) await r.drive(k * 5 * MIN, () => cell(k));
    expect(r.urls).toHaveLength(7);
    expect(r.watch.roadAt(r.now(), HOME.lat, HOME.lng)).toBeNull();
    expect(r.watch.roadAt(r.now(), cell(1).lat, cell(1).lng)).toEqual({});
    // At 35 min the third cell's answer is 20 min old: it is re-read; the first cell's was dropped: asked again.
    await r.drive(35 * MIN, () => cell(3));
    expect(r.urls).toHaveLength(7);
    await r.drive(35 * MIN + 10_000, () => HOME);
    expect(r.urls).toHaveLength(8);
    expect(r.urls.map(cellOf).at(-1)).toEqual(HOME);
  });

  test('the newest answer is saved: a relaunch keeps it (no request under 30 min); one 90 min old is dropped', async () => {
    let saved: unknown = null;
    const hold: WeatherHold = {
      read: async () => saved,
      write: async (s) => void (saved = JSON.parse(JSON.stringify(s))),
      clear: async () => void (saved = null),
    };
    const first = seriesRig({ hold, weather: () => ({ weather_code: 61, rain: 0.25 }) });
    await flush();
    first.watch.stop();
    expect(saved).toMatchObject({ lat: HOME.lat, lng: HOME.lng, fetchedAtMs: START });

    const relaunch = seriesRig({ hold, start: START + 10 * MIN });
    await flush();
    expect(relaunch.urls).toEqual([]);
    expect(relaunch.order).toEqual(['tag:rain', 'alert:none']);
    expect(relaunch.watch.roadAt(relaunch.now(), HOME.lat, HOME.lng)).toEqual({ g: 'wet' });
    relaunch.watch.stop();

    const late = seriesRig({ hold, start: START + 91 * MIN, respond: () => new Error('offline') });
    await flush();
    expect(late.urls).toHaveLength(1);
    expect(saved).toBeNull();
    expect(late.watch.roadAt(late.now(), HOME.lat, HOME.lng)).toBeNull();
  });

  test('the saved answer lives under one setting', async () => {
    const db = await createSqlJsDb();
    await migrate(db);
    const hold = weatherHoldIn(db);
    const series = parseRoadSeries(seriesBody(NOW), HOME.lat, HOME.lng, START)!;
    await hold.write(series);
    expect(await createSettingsRepo(db).get(WEATHER_HOLD_KEY)).toEqual(series);
    expect(reviveSeries(await hold.read())).toEqual(series);
    await hold.clear();
    expect(await hold.read()).toBeNull();
  });

  test('no position: nothing is asked until the drive’s first fix', async () => {
    const r = seriesRig({ position: null });
    await flush();
    expect(r.urls).toEqual([]);
    expect(r.order).toEqual([]);
    r.watch.onRow({ gnssValid: false, lat: 0, lng: 0 }, 0);
    await flush();
    expect(r.urls).toEqual([]);
    r.watch.onRow({ gnssValid: true, ...HOME }, 0);
    await flush();
    expect(r.urls.map(cellOf)).toEqual([HOME]);
  });

  test('a stopped watch asks and tells nothing more, even for a request still out', async () => {
    let release: (res: Response) => void = () => {};
    let n = 0;
    const told: (DangerAlert | null)[] = [];
    const watch = createWeatherWatch({
      now: () => START,
      fetch: () => ((n += 1), new Promise<Response>((res) => (release = res))),
      lastPosition: async () => HOME,
      onAlert: (a) => told.push(a),
    });
    await flush();
    expect(n).toBe(1);
    watch.stop();
    release(answer(seriesBody(NOW)));
    await flush();
    watch.onRow({ gnssValid: true, lat: 50, lng: 10 }, 0);
    await flush();
    expect(n).toBe(1);
    expect(told).toEqual([]);
  });

  test('the road’s title reads the air at the step', async () => {
    const r = seriesRig({ weather: () => ({ temperature_2m: 0.5 }) });
    await flush();
    expect(r.watch.roadTitle({ g: 'wet' }, r.now(), HOME.lat, HOME.lng)).toBe('Slippery roads');
    expect(r.watch.roadTitle({}, r.now(), HOME.lat, HOME.lng)).toBeNull();
    expect(r.watch.roadTitle({ g: 'wet' }, r.now(), 10, 10)).toBe('Wet roads');
  });

  test('a lookup seam has no road state', () => {
    const watch = createWeatherWatch({ now: () => 0, lookup: async () => null, lastPosition: async () => null, onAlert: () => {} });
    expect(watch.roadAt(0, 1, 2)).toBeNull();
    expect(watch.roadTitle({ g: 'wet' }, 0, 1, 2)).toBeNull();
  });
});
