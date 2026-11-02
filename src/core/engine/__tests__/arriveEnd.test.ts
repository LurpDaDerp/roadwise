// The place-arrival end (motion.ts `nextArrive` and a reported walk), through the real engine. Every time is on the row
// clock: a row at `ts` ends at `ts + 1 s`.
import { createDetectors } from '@/core/detectors';
import { limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineDeps, PlaceSpot, TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import { ARRIVE_LEFT_M, ARRIVE_NEAR_M, nextArrive, notePlacesLeft, placeAt } from '@/core/engine/motion';
import type { FeatureRow } from '@/core/engine/types';

const T0 = 1_700_000_000_000;
const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LNG = ((6371008.8 * Math.PI) / 180) * Math.cos((LAT * Math.PI) / 180);

interface Seg {
  n: number;
  mps: number;
  over?: (i: number) => Partial<FeatureRow>;
}

/** Rows from `t0` at 1 Hz, the position integrated east at each row's speed. */
function path(t0: number, ...segs: Seg[]): FeatureRow[] {
  const out: FeatureRow[] = [];
  let ts = t0;
  let x = 0;
  for (const seg of segs) {
    for (let i = 0; i < seg.n; i += 1) {
      out.push(row({ ts, lat: LAT, lng: LNG + x / M_PER_DEG_LNG, speed: seg.mps, ...(seg.over?.(i) ?? {}) }));
      x += Math.max(0, seg.mps);
      ts += 1000;
    }
  }
  return out;
}

function harness(over: Partial<EngineDeps> = {}) {
  const finalized: Readonly<TripSession>[] = [];
  let n = 0;
  const engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({ platform: 'ios' }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      finalized.push(s);
    },
    onCancel: async () => {},
    ...over,
  });
  return { engine, finalized };
}
type H = ReturnType<typeof harness>;

async function started(over: Partial<EngineDeps> = {}): Promise<H> {
  const h = harness(over);
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
  return h;
}
async function feed(h: H, rows: FeatureRow[], replay = false): Promise<void> {
  for (const r of rows) await h.engine.dispatch({ type: 'row', row: r, ...(replay ? { replay: true } : {}) });
}
const status = (h: H) => h.engine.snapshot().status;

/** 60 s at 30 mph from T0 (about 800 m east): the last movement mark at T0 + 59 s, so a cut ends the drive at T0 + 60 s. */
const DRIVE = { n: 60, mps: mph(30) };
const DRIVE_END = T0 + 60_000;
const DRIVE_M = 60 * mph(30);
/** A saved place `m` metres east of the start (default: where the car stops after `DRIVE`). */
const placeEast = (m = DRIVE_M, over: Partial<PlaceSpot> = {}): PlaceSpot => ({
  id: 'home',
  kind: 'home',
  name: 'Home',
  lat: LAT,
  lng: LNG + m / M_PER_DEG_LNG,
  ...over,
});
const HOME = [placeEast()];
const stopped = (n: number, over?: Seg['over']): Seg => ({ n, mps: 0, ...(over ? { over } : {}) });

/** A high-confidence walking report whose walk began at `since` (the engine reads it on the row clock: the latest row's end). */
const walk = (h: H, since: number) => h.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: since }, ts: since });
/** `DRIVE` then 20 s stopped at its end: rows 0–59 drive, 60–79 stand. Feeding rows 0–69 puts the row clock at T0 + 70 s. */
const ARRIVED = 70;

describe('the place arrival through the engine', () => {
  test('stopped at a saved place the car had left, 5 s into a reported walk ends the drive, cut where it last moved, with the place', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED));
    // Stopped there alone, nothing is due.
    expect(h.engine.snapshot().arriveAt).toBeNull();
    await walk(h, T0 + 68_000);
    // 5 s from the walk's start, the report standing 3 s from its arrival (T0 + 70 s).
    expect(h.engine.snapshot().arriveAt).toBe(T0 + 73_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 2));
    expect(status(h)).toBe('recording');
    await feed(h, rows.slice(ARRIVED + 2, ARRIVED + 3));
    expect(status(h)).toBe('idle');
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', cut: true, endedAt: DRIVE_END, endPlace: { id: 'home', kind: 'home', name: 'Home' } });
    expect(h.finalized[0]).not.toHaveProperty('endPlace.lat');
  });

  test('stopping at the place without walking never ends the drive', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(60)));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().arriveAt).toBeNull();
  });

  test('a late report: due 3 s after it arrives when its walk began earlier', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(20)).slice(0, ARRIVED));
    await walk(h, T0 + 61_000);
    expect(h.engine.snapshot().arriveAt).toBe(T0 + 73_000);
  });

  test('a walk that began before the car last drove is no arrival (the walk to the car)', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED));
    await walk(h, T0 + 50_000);
    expect(h.engine.snapshot().arriveAt).toBeNull();
    await feed(h, rows.slice(ARRIVED));
    expect(status(h)).toBe('recording');
  });

  test('a walk 110 m from the place is the plain walking end (10 s, no place); at 90 m it is the arrival', async () => {
    const far = await started({ places: () => [placeEast(DRIVE_M + 110)] });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(far, rows.slice(0, ARRIVED));
    await walk(far, T0 + 68_000);
    await feed(far, rows.slice(ARRIVED, ARRIVED + 3));
    expect(status(far)).toBe('recording');
    await feed(far, rows.slice(ARRIVED + 3, ARRIVED + 8));
    expect(far.finalized[0]).toMatchObject({ endCause: 'walking', endPlace: null });
    const near = await started({ places: () => [placeEast(DRIVE_M + 90)] });
    await feed(near, rows.slice(0, ARRIVED));
    await walk(near, T0 + 68_000);
    await feed(near, rows.slice(ARRIVED, ARRIVED + 3));
    expect(near.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('a fix worse than 20 m, or an untrusted speed, as it falls due puts it off to the next good row', async () => {
    for (const bad of [{ hAcc: 25 }, { speedAcc: 3 }]) {
      const h = await started({ places: () => HOME });
      const rows = path(T0, DRIVE, stopped(20, (i) => (i === 12 ? bad : {})));
      await feed(h, rows.slice(0, ARRIVED));
      await walk(h, T0 + 68_000);
      await feed(h, rows.slice(ARRIVED, ARRIVED + 3));
      expect(status(h)).toBe('recording');
      await feed(h, rows.slice(ARRIVED + 3, ARRIVED + 4));
      expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
    }
  });

  test('rows without a fix keep the car at the place', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(20, (i) => (i >= 10 ? { gnssValid: false, speed: -1 } : {})));
    await feed(h, rows.slice(0, ARRIVED));
    await walk(h, T0 + 68_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 3));
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('before driving speed, nothing', async () => {
    // 7 mph never reaches driving speed (10 mph).
    const n = 120;
    const h = await started({ places: () => [placeEast(n * mph(7))] });
    const rows = path(T0, { n, mps: mph(7) }, stopped(30));
    await feed(h, rows.slice(0, n + 10));
    await walk(h, T0 + (n + 8) * 1000);
    await feed(h, rows.slice(n + 10));
    expect(status(h)).toBe('recording');
  });

  test('a place the car never got 300 m from never ends the drive (a drive from home is not over in the driveway)', async () => {
    const run = async (n: number) => {
      const h = await started({ places: () => [placeEast(n * mph(30))] });
      const rows = path(T0, { n, mps: mph(30) }, stopped(20));
      await feed(h, rows.slice(0, n + 10));
      await walk(h, T0 + (n + 8) * 1000);
      await feed(h, rows.slice(n + 10, n + 13));
      return h;
    };
    // About 270 m: no arrival at 5 s.
    expect(status(await run(20))).toBe('recording');
    // About 335 m: the arrival.
    expect((await run(25)).finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('held while a Start-card drive waits', async () => {
    const h = await started({ places: () => HOME, holdEnds: () => true });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED));
    await walk(h, T0 + 68_000);
    await feed(h, rows.slice(ARRIVED));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().arriveAt).toBeNull();
  });

  test('a tick ends it on time when no row comes', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(20)).slice(0, ARRIVED));
    await walk(h, T0 + 68_000);
    await h.engine.dispatch({ type: 'tick', ts: T0 + 72_999 });
    expect(status(h)).toBe('recording');
    await h.engine.dispatch({ type: 'tick', ts: T0 + 73_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END, endPlace: { kind: 'home' } });
  });

  test('the nearest place within 100 m is the one; a custom place carries its own name', async () => {
    const shop = placeEast(DRIVE_M + 30, { id: 'place-1', kind: 'custom', name: 'Gym' });
    const h = await started({ places: () => [placeEast(DRIVE_M + 80, { id: 'work', kind: 'work', name: 'Work' }), shop] });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED));
    await walk(h, T0 + 68_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 3));
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'place-1', kind: 'custom', name: 'Gym' } });
  });

  test('two places 60 m apart: GPS jitter flipping the nearer one keeps the drive with the first', async () => {
    const west = placeEast(DRIVE_M - 30, { id: 'west', kind: 'custom', name: 'West' });
    const east = placeEast(DRIVE_M + 30, { id: 'east', kind: 'custom', name: 'East' });
    const h = await started({ places: () => [west, east] });
    const jitter = (i: number) => ({ lng: LNG + (DRIVE_M + (i % 2 === 0 ? 5 : -5)) / M_PER_DEG_LNG });
    const rows = path(T0, DRIVE, stopped(20, jitter));
    await feed(h, rows.slice(0, ARRIVED));
    // Due at T0 + 74 s: the row that ends then sits west of centre, nearer West.
    await walk(h, T0 + 69_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 4));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END, endPlace: { id: 'east' } });
  });

  test('replayed rows count: the rule reads only their fixes', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED), true);
    await walk(h, T0 + 68_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 3));
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('with no places, a walk is the plain walking end', async () => {
    const h = await started();
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, ARRIVED));
    await walk(h, T0 + 68_000);
    expect(h.engine.snapshot().arriveAt).toBeNull();
    await feed(h, rows.slice(ARRIVED));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endPlace: null });
  });

  test('places that land after the drive opened are read against the whole drive so far', async () => {
    let places: readonly PlaceSpot[] = [];
    const h = await started({ places: () => places });
    const rows = path(T0, DRIVE, stopped(20));
    await feed(h, rows.slice(0, 55));
    places = HOME;
    await feed(h, rows.slice(55, ARRIVED));
    await walk(h, T0 + 68_000);
    await feed(h, rows.slice(ARRIVED, ARRIVED + 3));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('another end leaves endPlace null', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE));
    await h.engine.dispatch({ type: 'end', ts: T0 + 61_000 });
    expect(h.finalized[0]?.endPlace).toBeNull();
  });
});

describe('the place helpers', () => {
  const home = placeEast(0);
  const fix = (m: number, over: Partial<FeatureRow> = {}) => row({ ts: T0, lat: LAT, lng: LNG + m / M_PER_DEG_LNG, speed: 0, ...over });

  test('placeAt: within 100 m, the nearest', () => {
    expect(placeAt(fix(ARRIVE_NEAR_M - 1), [home])).toBe(home);
    expect(placeAt(fix(ARRIVE_NEAR_M + 1), [home])).toBeNull();
  });

  test('notePlacesLeft: a fix more than 300 m off, accurate to 20 m', () => {
    const none = new Set<string>();
    expect(notePlacesLeft(none, [fix(ARRIVE_LEFT_M - 1)], [home])).toBe(none);
    expect(notePlacesLeft(none, [fix(ARRIVE_LEFT_M + 1, { hAcc: 30 })], [home])).toBe(none);
    expect([...notePlacesLeft(none, [fix(ARRIVE_LEFT_M + 1)], [home])]).toEqual(['home']);
  });

  test('nextArrive: starts, holds through a fix-less row, resets over 5 mph', () => {
    const left = new Set(['home']);
    const c = nextArrive(null, fix(10), [home], left);
    expect(c).toEqual({ place: home, since: T0 });
    expect(nextArrive(c, fix(10, { ts: T0 + 1000 }), [home], left)).toBe(c);
    expect(nextArrive(c, fix(10, { gnssValid: false, speed: -1 }), [home], left)).toBe(c);
    expect(nextArrive(c, fix(10, { speed: mph(6) }), [home], left)).toBeNull();
    expect(nextArrive(null, fix(10), [home], new Set())).toBeNull();
  });

  test('nextArrive: a running clock stays with its place while it is within 100 m, even when another is nearer', () => {
    const next = placeEast(60, { id: 'next', kind: 'custom', name: 'Next door' });
    const left = new Set(['home', 'next']);
    const c = nextArrive(null, fix(25), [home, next], left);
    expect(c?.place).toBe(home);
    expect(nextArrive(c, fix(35, { ts: T0 + 1000 }), [home, next], left)).toBe(c);
    expect(nextArrive(c, fix(ARRIVE_NEAR_M + 5, { ts: T0 + 2000 }), [home, next], left)).toEqual({ place: next, since: T0 + 2000 });
  });
});
