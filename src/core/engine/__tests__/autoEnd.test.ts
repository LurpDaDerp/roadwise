// The automatic end and the cut at the last movement (product spec v3 "Ending on its own";
// drive-lifecycle design §3): 15 min without movement, the 12 h bound, the manual cut after 2 min
// standing still, the ticks, adopt, and every parked-phone case that must not keep a drive alive.
import { IDLE_END_S } from '@scoring';

import { createDetectors } from '@/core/detectors';
import { limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineDeps, TripSession } from '@/core/engine/engine.types';
import { createEngine, MANUAL_CUT_AFTER_S } from '@/core/engine/machine';
import { appendRow, createSession } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';
import { MAX_DRIVE_MS } from '@/data/sync/payload';

const T0 = 1_700_000_000_000;
const IDLE_MS = IDLE_END_S * 1000;
const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);

interface Seg {
  n: number;
  /** GPS speed, m/s (-1 unknown). */
  mps: number;
  /** Metres east per row; default the speed (0 for an unknown speed). */
  step?: number | ((i: number) => number);
  /** Metres north of the line for row i (jitter). */
  north?: (i: number) => number;
  /** ms between rows; default 1000. */
  dt?: number;
  over?: (i: number) => Partial<FeatureRow>;
}

/** Rows in order from `t0`, the position integrated east segment after segment. */
function path(t0: number, ...segs: Seg[]): FeatureRow[] {
  const out: FeatureRow[] = [];
  let ts = t0;
  let x = 0;
  for (const seg of segs) {
    for (let i = 0; i < seg.n; i += 1) {
      const north = seg.north?.(i) ?? 0;
      out.push(row({ ts, lat: LAT + north / M_PER_DEG_LAT, lng: LNG + x / M_PER_DEG_LNG, speed: seg.mps, ...(seg.over?.(i) ?? {}) }));
      const step = typeof seg.step === 'function' ? seg.step(i) : (seg.step ?? Math.max(0, seg.mps));
      x += step * ((seg.dt ?? 1000) / 1000);
      ts += seg.dt ?? 1000;
    }
  }
  return out;
}

const DRIVE: Seg = { n: 60, mps: mph(30) };
const PARKED = (n: number, over: Partial<Seg> = {}): Seg => ({ n, mps: 0, step: 0, ...over });
/** A fix-less row on a mounted phone in a moving car (or an idling one): stable, unhandled, a little yaw. */
const vehicleNoFix = (): Partial<FeatureRow> => ({ gnssValid: false, speed: -1, gravityStability: 0.9, orientationDelta: 0.02, yawRateMax: 0.1 });
const handled = { handlingScore: 0.9, gravityStability: 0.5, orientationDelta: 0.2 };

function harness(over: Partial<EngineDeps> = {}) {
  const finalized: Readonly<TripSession>[] = [];
  let n = 0;
  const engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({ callActive: false, switchSignal: 'reliable', lockDelayMs: null, platform: 'android' }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      finalized.push(s);
    },
    ...over,
  });
  return { engine, finalized };
}

type H = ReturnType<typeof harness>;
async function feed(h: H, rows: FeatureRow[]): Promise<void> {
  for (const r of rows) await h.engine.dispatch({ type: 'row', row: r });
}
async function started(): Promise<H> {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  return h;
}
const status = (h: H) => h.engine.snapshot().status;
/** The drive's 60 s of driving end at T0 + 60 s (its last pace row is at T0 + 59 s). */
const PARKED_AT = T0 + 60_000;

test('(a) 60 s at 30 mph then stopped: recording at 899 s, ended at 900 s, cut at the last pace row + 1 s', async () => {
  const h = await started();
  const rows = path(T0, DRIVE, PARKED(IDLE_END_S));
  await feed(h, rows.slice(0, -1));
  expect(status(h)).toBe('recording');
  expect(h.engine.snapshot().autoEndAt).toBe(PARKED_AT + IDLE_MS);
  await feed(h, rows.slice(-1));
  expect(status(h)).toBe('idle');
  expect(rows.at(-1)!.ts + 1000).toBe(PARKED_AT + IDLE_MS);
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true, lastRowTs: PARKED_AT - 1000 });
});

test('(b) a drifting tail (±8 m, hAcc 6) is left out: miles, track, last fix, rows, valid rows and top speed are the mark’s', async () => {
  const h = await started();
  const tail = PARKED(IDLE_END_S, { mps: 0.4, north: (i) => 8 * Math.sin(i / 3), over: () => ({ hAcc: 6 }) });
  await feed(h, path(T0, DRIVE, tail));
  const s = h.finalized[0]!;
  const m = s.moved!;
  expect(s).toMatchObject({ distanceM: m.distanceM, rowsCount: 60, validGnssRows: 60, maxSpeedMps: m.maxSpeedMps, lastFix: m.lastFix });
  expect(s.track).toHaveLength(60);
  expect(s.distanceM).toBeCloseTo(59 * mph(30), 3);
});

test('(c) 40 min of 60 s stops with 5 s at 12 mph never ends', async () => {
  const h = await started();
  const cycles: Seg[] = [];
  for (let k = 0; k < 37; k += 1) cycles.push({ n: 5, mps: mph(12) }, PARKED(60));
  await feed(h, path(T0, DRIVE, ...cycles));
  expect(status(h)).toBe('recording');
});

test('(d) a drive-thru creeping at 1-3 mph Doppler, 240 m in 20 min, never ends', async () => {
  const h = await started();
  await feed(h, path(T0, DRIVE, { n: 1200, mps: mph(1), step: 0.2, over: (i) => (i % 10 === 0 ? { speed: mph(3) } : {}) }));
  expect(status(h)).toBe('recording');
  expect(h.engine.session()!.moved!.rowTs).toBeGreaterThan(PARKED_AT + 8 * 60_000);
});

test('(e) parked with one 7 mph spike every 60 s: ends 900 s after the real stop; a spike on the deadline row waits, the next slow row ends it', async () => {
  const h = await started();
  // Parked rows from T0 + 60 s; a spike on every row whose second is 59 mod 60 — the deadline row (T0 + 959 s) is one.
  const rows = path(T0, DRIVE, PARKED(IDLE_END_S + 1, { over: (i) => ((60 + i) % 60 === 59 ? { speed: mph(7) } : {}) }));
  const deadline = rows.findIndex((r) => r.ts === PARKED_AT + IDLE_MS - 1000);
  expect(rows[deadline]!.speed).toBeCloseTo(mph(7));
  await feed(h, rows.slice(0, deadline + 1));
  expect(status(h)).toBe('recording');
  await feed(h, rows.slice(deadline + 1));
  expect(status(h)).toBe('idle');
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT });
});

test('(f) parked 2 h with pairs of 3 mph readings every few minutes and ±15 m jitter: ends 900 s after the stop, miles of the mark', async () => {
  const h = await started();
  const tail = PARKED(7200, {
    north: (i) => 15 * Math.sin(i * 0.7),
    over: (i) => ({ hAcc: 6 + (i % 10), speed: i % 180 < 2 ? mph(3) : 0 }),
  });
  await feed(h, path(T0, DRIVE, tail));
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT });
  expect(h.finalized[0]!.distanceM).toBe(h.finalized[0]!.moved!.distanceM);
});

test('(g) multipath jumping 150 m out for 20 s every 2 min (hAcc 15): ends 900 s after the stop, miles of the mark', async () => {
  const h = await started();
  const tail = PARKED(IDLE_END_S + 30, { north: (i) => (i % 120 >= 100 ? 150 : 0), over: () => ({ hAcc: 15 }) });
  await feed(h, path(T0, DRIVE, tail));
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT });
  expect(h.finalized[0]!.distanceM).toBe(h.finalized[0]!.moved!.distanceM);
});

test('(h) parked, then a 5 min walk at 3.2 mph with the phone in hand (no motion access): ends 900 s after parking, cut there, no pickup', async () => {
  const h = await started();
  const walk: Seg = { n: 300, mps: mph(3.2), over: () => handled };
  await feed(h, path(T0, DRIVE, PARKED(30), walk, PARKED(IDLE_END_S)));
  const s = h.finalized[0]!;
  expect(s).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true });
  expect(s.events.filter((e) => e.type.startsWith('phone'))).toEqual([]);
  expect(s.distanceM).toBe(s.moved!.distanceM);
});

test('(i) a carried phone with no fix, and a still one, do not hold: both end 900 s after the stop', async () => {
  for (const tail of [
    { gnssValid: false, speed: -1, handlingScore: 0.7, gravityStability: 0.4, orientationDelta: 0.5 },
    { gnssValid: false, speed: -1, gravityStability: 0.99 },
  ]) {
    const h = await started();
    await feed(h, path(T0, DRIVE, PARKED(IDLE_END_S, { over: () => tail })));
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT });
  }
});

test('(j) no fix with a car-like IMU holds the drive open for an hour after the last movement, then the 15 min run out; cut at the movement', async () => {
  const h = await started();
  const rows = path(T0, DRIVE, PARKED(80 * 60, { over: vehicleNoFix }));
  const at20 = rows.findIndex((r) => r.ts >= PARKED_AT + 20 * 60_000);
  await feed(h, rows.slice(0, at20));
  expect(status(h)).toBe('recording');
  const at70 = rows.findIndex((r) => r.ts >= PARKED_AT + 70 * 60_000);
  await feed(h, rows.slice(at20, at70));
  expect(status(h)).toBe('recording');
  expect(h.engine.snapshot().autoEndAt).toBe(PARKED_AT + 3600_000 + IDLE_MS);
  await feed(h, rows.slice(at70));
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true });
});

test('(k) 20 min of approximate fixes (hAcc 2000, not valid) with a car-like IMU keep the drive open', async () => {
  const h = await started();
  await feed(h, path(T0, DRIVE, { n: 20 * 60, mps: -1, step: 13, over: () => ({ ...vehicleNoFix(), hAcc: 2000 }) }));
  expect(status(h)).toBe('recording');
});

test('(l) a 4 min tunnel at speed with no fix, then fixes 4 km on: still recording, and moving again after it', async () => {
  const h = await started();
  await feed(h, path(T0, DRIVE, { n: 240, mps: -1, step: 16.7, over: vehicleNoFix }, { n: 5, mps: mph(37) }));
  expect(status(h)).toBe('recording');
  expect(h.engine.session()!.moved!.rowTs).toBe(PARKED_AT + 244_000);
});

describe('(l2) a queue crawling at walking pace after driving speed (the walking-pace veto refuses its place travel)', () => {
  /** 7 s stopped, 5 s at 3.5 mph (7.8 m a cycle, over a third of the rows at walking pace): about 100 m every 2.6 min. */
  const jam = (minutes: number, over?: (i: number) => Partial<FeatureRow>): Seg[] => {
    const out: Seg[] = [];
    for (let k = 0; k < minutes * 5; k += 1) out.push({ n: 7, mps: 0, step: 0, ...(over ? { over } : {}) }, { n: 5, mps: mph(3.5), ...(over ? { over } : {}) });
    return out;
  };

  test('25 min of crawl with the phone mounted keeps the drive open; a pickup in it is kept once the car drives on', async () => {
    const h = await started();
    const crawl = jam(25);
    // a 10-s pickup 8 min into the queue
    crawl.splice(80, 1, { n: 7, mps: 0, step: 0, over: () => handled });
    await feed(h, path(T0, DRIVE, ...crawl));
    expect(status(h)).toBe('recording');
    expect(h.engine.session()!.moved!.rowTs).toBe(PARKED_AT - 1000); // the crawl itself is never movement
    const queueEnd = h.engine.session()!.lastRowTs! + 1000;
    await feed(h, path(queueEnd, DRIVE, PARKED(IDLE_END_S)));
    const s = h.finalized[0]!;
    expect(s).toMatchObject({ endCause: 'stopped', endedAt: queueEnd + 60_000, cut: true });
    expect(s.events.filter((e) => e.type === 'phone_pickup')).toEqual([expect.objectContaining({ stoppedInTraffic: true })]);
  });

  test('a crawl before the car ever reached 10 mph holds nothing: the drive ends 900 s after the tap and is not moved', async () => {
    const h = await started();
    await feed(h, path(T0, ...jam(16)));
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', moved: null, endedAt: T0 + IDLE_MS });
  });

  test('the same crawl with the phone carried (a driver walking off with it) holds nothing: ends 900 s after parking', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, ...jam(16, () => ({ orientationDelta: 0.5 }))));
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true });
  });

  test('an 80 min walk at 3.2 mph with the phone not carried (a shopping cart) holds the clock at most an hour after the last movement; cut there, no miles', async () => {
    const h = await started();
    const rows = path(T0, DRIVE, { n: 80 * 60, mps: mph(3.2) });
    const at70 = rows.findIndex((r) => r.ts >= PARKED_AT + 70 * 60_000);
    await feed(h, rows.slice(0, at70));
    expect(status(h)).toBe('recording');
    expect(h.engine.snapshot().autoEndAt).toBeLessThanOrEqual(PARKED_AT + 3600_000 + IDLE_MS);
    await feed(h, rows.slice(at70));
    const s = h.finalized[0]!;
    expect(s).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true });
    expect(s.distanceM).toBe(s.moved!.distanceM);
  });
});

test('(m) a drive that never moved ends 900 s after the tap with no mark', async () => {
  const h = await started();
  await feed(h, path(T0, PARKED(IDLE_END_S)));
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', moved: null, cut: false, endedAt: T0 + IDLE_MS });
});

test('(n) ticks: nothing at 899.999 s, the end at 900 s; a pace row on the deadline delays a tick 3 s later, not one 6 s later', async () => {
  const h = await started();
  await h.engine.dispatch({ type: 'tick', ts: T0 + IDLE_MS - 1 });
  expect(status(h)).toBe('recording');
  await h.engine.dispatch({ type: 'tick', ts: T0 + IDLE_MS });
  expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', moved: null });

  const g = await started();
  const rows = path(T0, DRIVE, PARKED(IDLE_END_S - 1));
  await feed(g, rows);
  const spike = row({ ts: PARKED_AT + IDLE_MS - 1000, lat: rows.at(-1)!.lat, lng: rows.at(-1)!.lng, speed: mph(7) });
  await feed(g, [spike]);
  expect(status(g)).toBe('recording');
  expect(g.engine.snapshot().autoEndAt).toBe(spike.ts + 6000);
  await g.engine.dispatch({ type: 'tick', ts: spike.ts + 3000 });
  expect(status(g)).toBe('recording');
  await g.engine.dispatch({ type: 'tick', ts: spike.ts + 6000 });
  expect(g.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT });
});

test('(o) a walking report on a drive that never moved closes it at 10 min with no mark (the idle end is later)', async () => {
  const h = await started();
  await feed(h, path(T0, { n: 3, mps: mph(1), step: 0.4 }));
  await h.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 2000 }, ts: T0 + 3000 });
  await h.engine.dispatch({ type: 'tick', ts: T0 + 599_999 });
  expect(status(h)).toBe('recording');
  await h.engine.dispatch({ type: 'tick', ts: T0 + 600_000 });
  expect(h.finalized[0]).toMatchObject({ endCause: 'walking', moved: null, droveAt: null, cut: false, endedAt: T0 + 3000 });
});

describe('(p) a manual end', () => {
  async function endAfter(parkedS: number, extra: Seg[] = []): Promise<Readonly<TripSession>> {
    const h = await started();
    const rows = path(T0, DRIVE, ...(extra.length ? extra : [PARKED(parkedS)]));
    await feed(h, rows);
    await h.engine.dispatch({ type: 'end', ts: PARKED_AT + parkedS * 1000 });
    return h.finalized[0]!;
  }

  test.each([30, MANUAL_CUT_AFTER_S - 1])('%s s after the last movement ends at the tap, uncut', async (s) => {
    expect(await endAfter(s)).toMatchObject({ endCause: 'manual', endedAt: PARKED_AT + s * 1000, cut: false });
  });

  test.each([MANUAL_CUT_AFTER_S, 600])('%s s after it is cut at the last movement', async (s) => {
    const closed = await endAfter(s);
    expect(closed).toMatchObject({ endCause: 'manual', endedAt: PARKED_AT, cut: true });
    expect(closed.distanceM).toBe(closed.moved!.distanceM);
  });

  test('phone use while standing still survives the cut: a pickup at a long red light, then End, keeps its penalty', async () => {
    // 150 s stopped (a long light), 10 s of handling, End at 165 s: the miles and route end at the
    // last movement, but the stopped-in-traffic pickup stays, and the drive runs to its end.
    const closed = await endAfter(165, [PARKED(150), PARKED(10, { over: () => handled }), PARKED(5)]);
    expect(closed).toMatchObject({ endCause: 'manual', cut: true });
    expect(closed.distanceM).toBe(closed.moved!.distanceM);
    const pickups = closed.events.filter((e) => e.type === 'phone_pickup');
    expect(pickups).toEqual([expect.objectContaining({ startedAt: PARKED_AT + 150_000, durationS: 10, stoppedInTraffic: true })]);
    expect(closed.endedAt).toBe(PARKED_AT + 160_000);
    for (const e of closed.events) expect(e.startedAt + e.durationS * 1000).toBeLessThanOrEqual(closed.endedAt!);
  });

  test('handling in the tail is kept whole (not clipped to the cut), and the end never passes the tap', async () => {
    const closed = await endAfter(600, [PARKED(120), PARKED(40, { over: () => handled }), PARKED(440)]);
    const pickup = closed.events.find((e) => e.type === 'phone_pickup');
    const handling = closed.events.find((e) => e.type === 'phone_handling');
    expect(pickup).toMatchObject({ startedAt: PARKED_AT + 120_000, durationS: 40, stoppedInTraffic: true });
    expect(handling).toMatchObject({ durationS: 25, tier: 'severe', units: 2 });
    expect(closed.endedAt).toBe(PARKED_AT + 160_000);
    // Handling still going at the tap: the drive ends at the tap, not after it.
    const atTap = await endAfter(149.5, [PARKED(130), PARKED(20, { over: () => handled })]);
    expect(atTap.events.some((e) => e.type === 'phone_pickup')).toBe(true);
    expect(atTap.endedAt).toBe(PARKED_AT + 149_500);
  });

  test('with no phone use after it, a cut manual end ends at the last movement; a pickup at a 1 min stop ended at 1:30 is kept uncut', async () => {
    expect(await endAfter(600)).toMatchObject({ cut: true, endedAt: PARKED_AT });
    const kept = await endAfter(90, [PARKED(60), PARKED(10, { over: () => handled }), PARKED(20)]);
    expect(kept.cut).toBe(false);
    expect(kept.events.filter((e) => e.type === 'phone_pickup')).toHaveLength(1);
  });

  test('a holding fix-less row restarts the 2 min', async () => {
    const closed = await endAfter(130, [PARKED(100), PARKED(1, { over: vehicleNoFix }), PARKED(29)]);
    expect(closed).toMatchObject({ cut: false, endedAt: PARKED_AT + 130_000 });
  });

  test('a never-moved drive ended by hand keeps its tap (it is dropped later, whatever ended it)', async () => {
    const h = await started();
    await feed(h, path(T0, PARKED(200)));
    await h.engine.dispatch({ type: 'end', ts: T0 + 200_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'manual', moved: null, cut: false, endedAt: T0 + 200_000 });
  });

  test('an End that comes after the automatic end was due (no row or tick since) ends as that end would', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, PARKED(10)));
    await h.engine.dispatch({ type: 'end', ts: PARKED_AT + IDLE_MS + 60_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: PARKED_AT, cut: true });
  });
});

test('(q) an adopted drive whose last movement is 20 min old ends on the first tick, cut at that movement', async () => {
  const session = createSession({ clientTripId: 'old', startedAt: T0 });
  for (const r of path(T0, DRIVE, PARKED(60))) appendRow(session, r, false);
  const h = harness();
  await h.engine.dispatch({ type: 'adopt', trip: { session, detectors: createDetectors(() => 'x') }, ts: PARKED_AT + 20 * 60_000 });
  expect(h.engine.snapshot().autoEndAt).toBe(PARKED_AT + IDLE_MS);
  await h.engine.dispatch({ type: 'tick', ts: PARKED_AT + 20 * 60_000 });
  expect(h.finalized[0]).toMatchObject({ clientTripId: 'old', endCause: 'stopped', endedAt: PARKED_AT, cut: true });
});

test('(r) the snapshot’s autoEndAt: start + 900 s, then the latest movement + 901 s, the pace grace, null when idle', async () => {
  const h = harness();
  expect(h.engine.snapshot().autoEndAt).toBeNull();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  expect(h.engine.snapshot().autoEndAt).toBe(T0 + IDLE_MS);
  const rows = path(T0, { n: 2, mps: mph(30) });
  await feed(h, rows);
  expect(h.engine.snapshot().autoEndAt).toBe(T0 + 1000 + 901_000);
  await feed(h, path(T0 + 2000, PARKED(IDLE_END_S - 3)));
  const last = h.engine.session()!.lastRowTs!;
  await feed(h, [row({ ts: last + 1000, lat: LAT, lng: LNG, speed: mph(9) })]);
  expect(h.engine.snapshot().autoEndAt).toBe(last + 1000 + 6000);
  await h.engine.dispatch({ type: 'end', ts: last + 2000 });
  expect(h.engine.snapshot().autoEndAt).toBeNull();
});

describe('(s) the 12 h bound', () => {
  test('a drive still moving at 12 h ends with cause limit, cut inside the bound, and takes in no row past it', async () => {
    const h = await started();
    // One fix a minute, 1 km apart, no speed: place movement every other fix.
    const rows = path(T0, { n: 722, mps: -1, step: 1000 / 60, dt: 60_000 });
    await feed(h, rows);
    const s = h.finalized[0]!;
    expect(s.endCause).toBe('limit');
    expect(s.cut).toBe(true);
    expect(s.endedAt! - s.startedAt).toBeLessThanOrEqual(MAX_DRIVE_MS);
    expect(s.lastRowTs!).toBeLessThan(T0 + MAX_DRIVE_MS);
  });

  test('a movement row 1 s before the bound is the last one taken in: the cut lands exactly on 12 h', async () => {
    const h = await started();
    const rows = path(T0, { n: 720, mps: -1, step: 1000 / 60, dt: 60_000 });
    await feed(h, rows);
    expect(status(h)).toBe('recording');
    const last = rows.at(-1)!;
    const pace = (ts: number, eastM: number) => row({ ts, lat: last.lat, lng: last.lng + eastM / M_PER_DEG_LNG, speed: mph(30) });
    await feed(h, [pace(T0 + MAX_DRIVE_MS - 2000, 500), pace(T0 + MAX_DRIVE_MS - 1000, 513)]);
    expect(h.finalized[0]).toMatchObject({ endCause: 'limit', cut: true, endedAt: T0 + MAX_DRIVE_MS, lastRowTs: T0 + MAX_DRIVE_MS - 1000 });
  });

  test('a row that would carry the drive past 12 h is not taken in: the drive ends first, cut at its last movement', async () => {
    const h = await started();
    const rows = path(T0, { n: 720, mps: -1, step: 1000 / 60, dt: 60_000 });
    await feed(h, rows);
    const last = rows.at(-1)!;
    const pace = (ts: number, eastM: number) => row({ ts, lat: last.lat, lng: last.lng + eastM / M_PER_DEG_LNG, speed: mph(30) });
    // Taken in, the second would make movement at 12 h − 999 ms and a cut 1 ms past the bound.
    await feed(h, [pace(T0 + MAX_DRIVE_MS - 1999, 500), pace(T0 + MAX_DRIVE_MS - 999, 513)]);
    const s = h.finalized[0]!;
    expect(s).toMatchObject({ endCause: 'limit', cut: true });
    expect(s.lastRowTs).toBeLessThanOrEqual(T0 + MAX_DRIVE_MS - 1999);
    expect(s.endedAt! - s.startedAt).toBeLessThan(MAX_DRIVE_MS);
  });

  test('a parked phone held open by a car-like IMU ends by the 15 min rule long before 12 h', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, PARKED(80 * 60, { over: vehicleNoFix })));
    expect(h.finalized[0]!.endCause).toBe('stopped');
  });
});
