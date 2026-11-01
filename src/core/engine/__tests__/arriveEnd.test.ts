// The place-arrival end (motion.ts `nextArrive`), through the real engine. Every time is on the row
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

describe('the place arrival through the engine', () => {
  test('10 s stopped at a saved place the car had left ends the drive, cut where it last moved, with the place', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(30));
    await feed(h, rows.slice(0, 69));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().arriveAt).toBe(T0 + 70_000);
    await feed(h, rows.slice(69, 70));
    expect(status(h)).toBe('idle');
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', cut: true, endedAt: DRIVE_END, endPlace: { id: 'home', kind: 'home', name: 'Home' } });
    expect(h.finalized[0]).not.toHaveProperty('endPlace.lat');
  });

  test('9 s is not enough', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(9)));
    expect(status(h)).toBe('recording');
  });

  test('a row over 5 mph starts the 10 s again', async () => {
    const h = await started({ places: () => HOME });
    const rows = path(T0, DRIVE, stopped(5), { n: 1, mps: mph(6) }, stopped(10));
    await feed(h, rows.slice(0, -1));
    expect(status(h)).toBe('recording');
    await feed(h, rows.slice(-1));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('a stop 110 m from the place is no arrival; 90 m is', async () => {
    const far = await started({ places: () => [placeEast(DRIVE_M + 110)] });
    await feed(far, path(T0, DRIVE, stopped(30)));
    expect(status(far)).toBe('recording');
    const near = await started({ places: () => [placeEast(DRIVE_M + 90)] });
    await feed(near, path(T0, DRIVE, stopped(30)));
    expect(status(near)).toBe('idle');
  });

  test('a fix worse than 20 m, or an untrusted speed, does not count and resets the clock', async () => {
    const poor = await started({ places: () => HOME });
    await feed(poor, path(T0, DRIVE, stopped(30, (i) => (i === 5 ? { hAcc: 25 } : {}))).slice(0, 75));
    expect(status(poor)).toBe('recording');
    const untrusted = await started({ places: () => HOME });
    await feed(untrusted, path(T0, DRIVE, stopped(30, (i) => (i === 5 ? { speedAcc: 3 } : {}))).slice(0, 75));
    expect(status(untrusted)).toBe('recording');
    // The clock from the row after the poor one: 10 s more ends it.
    await feed(poor, path(T0, DRIVE, stopped(30)).slice(75, 76));
    expect(status(poor)).toBe('idle');
  });

  test('a row without a fix keeps the clock running', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(10, (i) => (i >= 3 && i <= 6 ? { gnssValid: false, speed: -1 } : {}))));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'home' } });
  });

  test('before driving speed, nothing', async () => {
    // 7 mph never reaches driving speed (10 mph).
    const n = 120;
    const h = await started({ places: () => [placeEast(n * mph(7))] });
    await feed(h, path(T0, { n, mps: mph(7) }, stopped(30)));
    expect(status(h)).toBe('recording');
  });

  test('a place the car never got 300 m from never ends the drive (a drive from home is not over in the driveway)', async () => {
    const short = 20 * mph(30); // about 270 m
    const stay = await started({ places: () => [placeEast(short)] });
    await feed(stay, path(T0, { n: 20, mps: mph(30) }, stopped(30)));
    expect(status(stay)).toBe('recording');
    const longer = 25 * mph(30); // about 335 m
    const left = await started({ places: () => [placeEast(longer)] });
    await feed(left, path(T0, { n: 25, mps: mph(30) }, stopped(30)));
    expect(status(left)).toBe('idle');
  });

  test('held while a Start-card drive waits', async () => {
    const h = await started({ places: () => HOME, holdEnds: () => true });
    await feed(h, path(T0, DRIVE, stopped(30)));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().arriveAt).toBeNull();
  });

  test('a tick ends it on time when no row comes', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(3)));
    await h.engine.dispatch({ type: 'tick', ts: T0 + 69_000 });
    expect(status(h)).toBe('recording');
    await h.engine.dispatch({ type: 'tick', ts: T0 + 70_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: DRIVE_END, endPlace: { kind: 'home' } });
  });

  test('the nearest place within 100 m is the one; a custom place carries its own name', async () => {
    const shop = placeEast(DRIVE_M + 30, { id: 'place-1', kind: 'custom', name: 'Gym' });
    const h = await started({ places: () => [placeEast(DRIVE_M + 80, { id: 'work', kind: 'work', name: 'Work' }), shop] });
    await feed(h, path(T0, DRIVE, stopped(10)));
    expect(h.finalized[0]).toMatchObject({ endPlace: { id: 'place-1', kind: 'custom', name: 'Gym' } });
  });

  test('replayed rows count: the rule reads only their fixes', async () => {
    const h = await started({ places: () => HOME });
    await feed(h, path(T0, DRIVE, stopped(10)), true);
    expect(status(h)).toBe('idle');
  });

  test('with no places, nothing', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, stopped(30)));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().arriveAt).toBeNull();
  });

  test('places that land after the drive opened are read against the whole drive so far', async () => {
    let places: readonly PlaceSpot[] = [];
    const h = await started({ places: () => places });
    const rows = path(T0, DRIVE, stopped(30));
    await feed(h, rows.slice(0, 55));
    places = HOME;
    await feed(h, rows.slice(55, 70));
    expect(status(h)).toBe('idle');
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
});
