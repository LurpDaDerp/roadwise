// The walking end (product spec v3 "Ending on its own"; motion.ts W1/W2) and the shown speed (S2),
// through the real engine. Every time is on the row clock: a row at `ts` ends at `ts + 1 s`.
import type { MotionActivity } from '@drive-sense';

import { createDetectors } from '@/core/detectors';
import { limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineDeps, TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import { ON_FOOT_DROP_MS, WALK_CONFIRM_MS } from '@/core/engine/motion';
import { appendRow, createSession } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';

const T0 = 1_700_000_000_000;
const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LNG = ((6371008.8 * Math.PI) / 180) * Math.cos((LAT * Math.PI) / 180);

interface Seg {
  n: number;
  /** GPS speed, m/s (-1 unknown). */
  mps: number;
  over?: (i: number) => Partial<FeatureRow>;
}

/** Rows in order from `t0` at 1 Hz, the position integrated east from `x0` metres at each row's speed. */
function path(t0: number, x0: number, ...segs: Seg[]): FeatureRow[] {
  const out: FeatureRow[] = [];
  let ts = t0;
  let x = x0;
  for (const seg of segs) {
    for (let i = 0; i < seg.n; i += 1) {
      out.push(row({ ts, lat: LAT, lng: LNG + x / M_PER_DEG_LNG, speed: seg.mps, ...(seg.over?.(i) ?? {}) }));
      x += Math.max(0, seg.mps);
      ts += 1000;
    }
  }
  return out;
}
const metresAfter = (rows: FeatureRow[]): number => (rows.length === 0 ? 0 : (rows.at(-1)!.lng - LNG) * M_PER_DEG_LNG + Math.max(0, rows.at(-1)!.speed));

/** No fix, a still phone: no speed, holds nothing. */
const noFix = (): Partial<FeatureRow> => ({ gnssValid: false, speed: -1 });

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

async function started(): Promise<H> {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  return h;
}
async function feed(h: H, rows: FeatureRow[]): Promise<void> {
  for (const r of rows) await h.engine.dispatch({ type: 'row', row: r });
}
const act = (type: MotionActivity['type'], ts: number, confidence: MotionActivity['confidence'] = 'high', exit?: true): MotionActivity => ({
  type,
  confidence,
  ts,
  ...(exit ? { exit } : {}),
});
/** A report arriving at `arrival` (the host's clock; the engine uses it only before the first row). */
const report = (h: H, a: MotionActivity, arrival = T0) => h.engine.dispatch({ type: 'motion', activity: a, ts: arrival });
const status = (h: H) => h.engine.snapshot().status;

/** 60 s at 30 mph from T0: driving speed at T0 + 1 s, the last movement mark at T0 + 59 s. */
const DRIVE = { n: 60, mps: mph(30) };
const DRIVE_END = T0 + 60_000;

describe('W2: a drive that has not reached driving speed', () => {
  test('1. the walk to the car (reported before the tap) ends a never-driven drive only at 10 min, and it was never driven', async () => {
    const h = await started();
    await report(h, act('walking', T0 - 60_000), T0);
    const still = path(T0, 0, { n: 600, mps: 0 });
    await feed(h, still.slice(0, 599));
    expect(status(h)).toBe('recording');
    expect(h.engine.session()!.lastRowTs! + 1000 - T0).toBe(ON_FOOT_DROP_MS - 1000);
    await feed(h, still.slice(599));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', droveAt: null, moved: null, cut: false, endedAt: T0 + 600_000 });
  });

  test('2. an interrupted walk reported after the tap: no end before driving speed (still recording at 5 min)', async () => {
    const h = await started();
    const still = path(T0, 0, { n: 300, mps: 0 });
    await feed(h, still.slice(0, 13));
    await report(h, act('walking', T0 + 12_000), T0 + 13_000);
    await feed(h, still.slice(13));
    expect(status(h)).toBe('recording');
  });

  test('a report under 20 s old at 10 min waits for its 20 s', async () => {
    const h = await started();
    const still = path(T0, 0, { n: 640, mps: 0 });
    await feed(h, still.slice(0, 595));
    await report(h, act('walking', T0 + 590_000));
    // Arrived at T0 + 595 s (row clock): due at T0 + 615 s, past the 10 min.
    await feed(h, still.slice(595, 614));
    expect(status(h)).toBe('recording');
    await feed(h, still.slice(614, 615));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', droveAt: null });
  });

  test('driving speed reached after a pre-start walk report: the two driving rows cancel it', async () => {
    const h = await started();
    await report(h, act('walking', T0 - 30_000), T0);
    await feed(h, path(T0, 0, { n: 5, mps: 0 }, DRIVE, { n: 120, mps: 0 }));
    expect(status(h)).toBe('recording');
    expect(h.engine.session()!.droveAt).toBe(T0 + 6000);
  });
});

describe('W1: after driving speed', () => {
  /** 60 s at 30 mph, 10 s stopped, then `n` rows on foot at `mps` from T0 + 70 s. */
  const walkOff = (mps: number, n: number) => {
    const head = path(T0, 0, DRIVE, { n: 10, mps: 0 });
    return [...head, ...path(T0 + 70_000, metresAfter(head), { n, mps })];
  };

  test('4. a walk-off at 3.4 mph with a fresh fix ends 20 s after the report arrives, cut at the last movement before the walk', async () => {
    const h = await started();
    const rows = walkOff(mph(3.4), 60);
    // The report of the walk that began at T0 + 70 s arrives 30 s later (after the row at T0 + 99 s).
    await feed(h, rows.slice(0, 100));
    await report(h, act('walking', T0 + 70_000));
    await feed(h, rows.slice(100, 119));
    expect(status(h)).toBe('recording');
    const distanceAtMark = h.engine.session()!.marks.findLast((m) => m.rowTs <= T0 + 70_000)!.distanceM;
    await feed(h, rows.slice(119, 120));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END, cut: true, lastRowTs: DRIVE_END - 1000, droveAt: T0 + 1000 });
    expect(h.finalized[0]!.distanceM).toBe(distanceAtMark);
  });

  test('5. running at 6 mph (pace movement on foot) ends the same way, cut before the run', async () => {
    const h = await started();
    const rows = walkOff(mph(6), 60);
    await feed(h, rows.slice(0, 100));
    expect(h.engine.session()!.moved!.rowTs).toBeGreaterThan(T0 + 70_000);
    await report(h, act('running', T0 + 70_000, 'medium'));
    await feed(h, rows.slice(100, 120));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END, cut: true });
  });

  test('6. a misfire at 40 mph: two driving rows cancel it, and a later stop does not revive it', async () => {
    const h = await started();
    const fast = path(T0, 0, { n: 60, mps: mph(40) });
    await feed(h, fast);
    await report(h, act('walking', T0 + 30_000));
    await feed(h, path(T0 + 60_000, metresAfter(fast), { n: 2, mps: mph(40) }, { n: 120, mps: 0 }));
    expect(status(h)).toBe('recording');
  });

  test('6b. a report the car was at driving speed around: one driving row before it and one after cancel it', async () => {
    const h = await started();
    const fast = path(T0, 0, { n: 60, mps: mph(40) });
    await feed(h, fast);
    // The walk "began" at the report's arrival (the end of the row at T0 + 59 s); the next row is the
    // second driving reading in a row after it began.
    await report(h, act('walking', T0 + 60_000));
    await feed(h, path(T0 + 60_000, metresAfter(fast), { n: 1, mps: mph(40) }, { n: 120, mps: 0 }));
    expect(status(h)).toBe('recording');
  });

  test('6c. a late report stamped before later driving never ends the drive (as if it had come on time)', async () => {
    const h = await started();
    // 60 s at 30 mph, a 15 s light, 140 s at 30 mph, then a stop from T0 + 215 s.
    const head = path(T0, 0, DRIVE, { n: 15, mps: 0 }, { n: 140, mps: mph(30) });
    const stop = path(T0 + 215_000, metresAfter(head), { n: 120, mps: 0 });
    await feed(h, head);
    const driven = h.engine.session()!.distanceM;
    await feed(h, stop.slice(0, 5));
    // A misread stamped at the first light, arriving 5 s into the final stop.
    await report(h, act('walking', T0 + 65_000));
    await feed(h, stop.slice(5));
    expect(status(h)).toBe('recording');
    // A fresh report of a walk that began in the final stop ends it there, keeping all of the driving.
    await report(h, act('walking', T0 + 330_000), T0 + 335_000);
    await feed(h, path(T0 + 335_000, metresAfter(head), { n: 20, mps: 0 }));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 215_000, cut: true });
    expect(h.finalized[0]!.distanceM).toBeCloseTo(driven, 6);
  });

  test('6d. a late report whose walk began after the last driving reading still ends the drive', async () => {
    const h = await started();
    const head = path(T0, 0, DRIVE, { n: 15, mps: 0 }, { n: 140, mps: mph(30) });
    const stop = path(T0 + 215_000, metresAfter(head), { n: 60, mps: 0 });
    await feed(h, [...head, ...stop.slice(0, 30)]);
    // Stamped 1 s after the last driving reading (the row at T0 + 214 s), arriving 30 s later.
    await report(h, act('walking', T0 + 215_000));
    await feed(h, stop.slice(30, 50));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 215_000, cut: true });
  });

  test('7. a misread at a red light (car stopped, fresh fix) ends 20 s after it arrives, cut at the last movement at or before it', async () => {
    const h = await started();
    const fast = path(T0, 0, { n: 60, mps: mph(40) });
    await feed(h, fast);
    await report(h, act('walking', T0 + 59_500));
    const stopped = path(T0 + 60_000, metresAfter(fast), { n: 30, mps: 0 });
    await feed(h, stopped.slice(0, 19));
    expect(status(h)).toBe('recording');
    await feed(h, stopped.slice(19, 20));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 60_000, cut: true });
  });

  test('8. a garage entered at 15 mph: the walk waits until the last fix is over 60 s old, then ends, cut before the walk', async () => {
    const h = await started();
    const head = path(T0, 0, DRIVE, { n: 5, mps: mph(15) });
    const dark = path(T0 + 65_000, metresAfter(head), { n: 80, mps: -1, over: noFix });
    await feed(h, [...head, ...dark.slice(0, 5)]);
    // The last fix is the row at T0 + 64 s; the walk began at T0 + 66 s, reported after the row at T0 + 69 s.
    await report(h, act('walking', T0 + 66_000));
    // 20 s pass at T0 + 90 s, but the car was last known at 15 mph: wait while that is ≤ 60 s old.
    await feed(h, dark.slice(5, 59));
    expect(h.engine.session()!.lastRowTs).toBe(T0 + 123_000);
    expect(status(h)).toBe('recording');
    await feed(h, dark.slice(59, 60));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 65_000, cut: true });
  });

  test('9. a late report of a walk that began before driving speed is ignored', async () => {
    const h = await started();
    const head = path(T0, 0, { n: 2, mps: mph(30) });
    await feed(h, [...head, ...path(T0 + 2000, metresAfter(head), { n: 38, mps: 0 })]);
    expect(h.engine.session()!.droveAt).toBe(T0 + 1000);
    await report(h, act('walking', T0 - 10_000));
    await feed(h, path(T0 + 40_000, metresAfter(head), { n: 60, mps: 0 }));
    expect(status(h)).toBe('recording');
    // A walk that began at the reading that reached driving speed is void; only one after it counts.
    await report(h, act('walking', T0 + 1000));
    await feed(h, path(T0 + 100_000, metresAfter(head), { n: 30, mps: 0 }));
    expect(status(h)).toBe('recording');
    await report(h, act('walking', T0 + 1001));
    await feed(h, path(T0 + 130_000, metresAfter(head), { n: 20, mps: 0 }));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 2000 });
  });

  test('10. an ENTER and its EXIT (or IN_VEHICLE) in one batch never end the drive', async () => {
    for (const second of [act('walking', T0 + 65_000, 'high', true), act('automotive', T0 + 65_000)]) {
      const h = await started();
      const head = path(T0, 0, DRIVE, { n: 10, mps: 0 });
      await feed(h, head);
      await report(h, act('walking', T0 + 64_000));
      await report(h, second);
      await feed(h, path(T0 + 70_000, metresAfter(head), { n: 60, mps: 0 }));
      expect(status(h)).toBe('recording');
    }
  });

  test('11. low confidence leaves the standing report; automotive, stationary, cycling and unknown clear it; low alone sets nothing', async () => {
    const run = async (...reports: MotionActivity[]) => {
      const h = await started();
      const head = path(T0, 0, DRIVE, { n: 10, mps: 0 });
      await feed(h, head);
      for (const a of reports) await report(h, a);
      await feed(h, path(T0 + 70_000, metresAfter(head), { n: 30, mps: 0 }));
      return status(h);
    };
    expect(await run(act('walking', T0 + 65_000), act('walking', T0 + 66_000, 'low'))).toBe('idle');
    expect(await run(act('walking', T0 + 65_000, 'low'))).toBe('recording');
    expect(await run(act('running', T0 + 65_000, 'low'))).toBe('recording');
    for (const type of ['automotive', 'stationary', 'cycling', 'unknown'] as const) {
      for (const c of ['low', 'medium', 'high'] as const) expect(await run(act('walking', T0 + 65_000), act(type, T0 + 66_000, c))).toBe('recording');
    }
  });

  test('3. a confidence change (medium, then high) keeps the first report’s times: the end comes 20 s after the first arrives', async () => {
    const h = await started();
    const head = path(T0, 0, DRIVE, { n: 10, mps: 0 });
    await feed(h, head);
    await report(h, act('walking', T0 + 62_000, 'medium'));
    const stopped = path(T0 + 70_000, metresAfter(head), { n: 40, mps: 0 });
    await feed(h, stopped.slice(0, 12));
    await report(h, act('walking', T0 + 80_000, 'high'));
    await feed(h, stopped.slice(12, 19));
    expect(status(h)).toBe('recording');
    // First arrival at T0 + 70 s: due at T0 + 90 s, the row at T0 + 89 s.
    await feed(h, stopped.slice(19, 20));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END });
  });

  test('a report on a tick: the end is checked on the engine’s timer too', async () => {
    const h = await started();
    await feed(h, path(T0, 0, DRIVE, { n: 10, mps: 0 }));
    await report(h, act('walking', T0 + 65_000));
    await h.engine.dispatch({ type: 'tick', ts: T0 + 70_000 + WALK_CONFIRM_MS - 1 });
    expect(status(h)).toBe('recording');
    await h.engine.dispatch({ type: 'tick', ts: T0 + 70_000 + WALK_CONFIRM_MS });
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END });
  });
});

describe('12. an adopted drive', () => {
  function adopted(): TripSession {
    const s = createSession({ clientTripId: 'old', startedAt: T0 });
    for (const r of path(T0, 0, DRIVE)) appendRow(s, r, false);
    return s;
  }

  test('rows ending at 30 mph 10 s ago: a report before any new row waits; two 30 mph rows clear it', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'adopt', trip: { session: adopted(), detectors: createDetectors(() => 'x') }, ts: T0 + 69_000 });
    expect(h.engine.snapshot().lockedOut).toBe(true);
    await report(h, act('walking', T0 + 68_000), T0 + 69_000);
    await h.engine.dispatch({ type: 'tick', ts: T0 + 89_000 });
    expect(status(h)).toBe('recording');
    await feed(h, path(T0 + 90_000, 900, { n: 2, mps: mph(30) }, { n: 60, mps: 0 }));
    await h.engine.dispatch({ type: 'tick', ts: T0 + 200_000 });
    expect(status(h)).toBe('recording');
  });

  test('rows that ended 70 s ago: a report ends it 20 s later, cut at the last movement', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'adopt', trip: { session: adopted(), detectors: createDetectors(() => 'x') }, ts: T0 + 129_000 });
    await report(h, act('walking', T0 + 120_000), T0 + 129_000);
    await h.engine.dispatch({ type: 'tick', ts: T0 + 148_999 });
    expect(status(h)).toBe('recording');
    await h.engine.dispatch({ type: 'tick', ts: T0 + 149_000 });
    expect(h.finalized[0]).toMatchObject({ clientTripId: 'old', endCause: 'walking', endedAt: DRIVE_END, cut: true });
  });
});

describe('13. walking or jogging with a drive open', () => {
  /** 0.6 mi at 3 mph with a fix: pace no, driving speed never. */
  const jog = () => path(T0, 0, { n: 720, mps: mph(3) });

  test('with the walk to the car reported, W2 ends it at 10 min and it was never driven', async () => {
    const h = await started();
    await report(h, act('walking', T0 - 60_000), T0);
    await feed(h, jog());
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', droveAt: null, endedAt: T0 + 600_000 });
  });

  test('without any report, a manual end still leaves a drive that never reached driving speed', async () => {
    const h = await started();
    await feed(h, jog());
    await h.engine.dispatch({ type: 'end', ts: T0 + 720_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'manual', droveAt: null });
  });
});

describe('14. reset', () => {
  test('a standing report does not leak into the next drive', async () => {
    const h = await started();
    await feed(h, path(T0, 0, DRIVE, { n: 5, mps: 0 }));
    await report(h, act('walking', T0 + 63_000));
    await h.engine.dispatch({ type: 'end', ts: T0 + 66_000 });
    expect(h.finalized[0]!.endCause).toBe('manual');
    await h.engine.dispatch({ type: 'start', ts: T0 + 100_000, continues: false });
    await feed(h, path(T0 + 100_000, 0, DRIVE, { n: 60, mps: 0 }));
    expect(status(h)).toBe('recording');
  });

  test('a report while idle is ignored and changes nothing', async () => {
    const h = harness();
    await report(h, act('walking', T0));
    expect(status(h)).toBe('idle');
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    await feed(h, path(T0, 0, DRIVE, { n: 60, mps: 0 }));
    expect(status(h)).toBe('recording');
  });

  test('an adopt starts with no standing report', async () => {
    const h = await started();
    await feed(h, path(T0, 0, DRIVE));
    await report(h, act('walking', T0 + 30_000));
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    const s = createSession({ clientTripId: 'old', startedAt: T0 + 100_000 });
    for (const r of path(T0 + 100_000, 0, DRIVE)) appendRow(s, r, false);
    await h.engine.dispatch({ type: 'adopt', trip: { session: s, detectors: createDetectors(() => 'x') }, ts: T0 + 161_000 });
    await feed(h, path(T0 + 161_000, 900, { n: 60, mps: 0 }));
    expect(status(h)).toBe('recording');
  });
});

describe('15. S2: the shown speed', () => {
  async function shown(over: Partial<FeatureRow>) {
    const h = await started();
    await feed(h, [row({ ts: T0, ...over })]);
    return h.engine.snapshot();
  }

  test('0 while the speed is below its own accuracy and under 3 mph; the raw speed otherwise', async () => {
    expect(await shown({ speed: 0.8, speedAcc: 1.0 })).toMatchObject({ speedMps: 0, speedKnown: true, stopped: true });
    expect((await shown({ speed: 0.8, speedAcc: 0.5 })).speedMps).toBe(0.8);
    expect((await shown({ speed: 1.5, speedAcc: 3.0 })).speedMps).toBe(1.5);
    expect((await shown({ speed: 0.8, speedAcc: -1 })).speedMps).toBe(0.8);
    expect(await shown({ speed: -1, gnssValid: false })).toMatchObject({ speedMps: 0, speedKnown: false });
  });

  test('stopped and lockedOut read the raw speed', async () => {
    // 2.5 m/s (5.6 mph) rated at 3 m/s: shown as is (not under 3 mph), not stopped, locked out.
    expect(await shown({ speed: 2.5, speedAcc: 3 })).toMatchObject({ speedMps: 2.5, stopped: false, lockedOut: true });
  });
});
