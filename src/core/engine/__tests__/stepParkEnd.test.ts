// The step walk and the known parking spot (motion.ts), through the real engine. Every time is on
// the row clock: a row at `ts` ends at `ts + 1 s`.
import type { MotionActivity } from '@drive-sense';

import { createDetectors } from '@/core/detectors';
import { limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineDeps, TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import { noteSteps, ON_FOOT_DROP_MS, stepWalk, vehicleReading, type StepMark } from '@/core/engine/motion';
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
const act = (type: MotionActivity['type'], ts: number, confidence: MotionActivity['confidence'] = 'high'): MotionActivity => ({ type, confidence, ts });
const status = (h: H) => h.engine.snapshot().status;

/** 60 s at 30 mph from T0: the last movement mark at T0 + 59 s, so a cut ends the drive at T0 + 60 s. */
const DRIVE = { n: 60, mps: mph(30) };
const DRIVE_END = T0 + 60_000;
/** Where the car stops after `DRIVE`. */
const PARKED = { lat: LAT, lng: LNG + (60 * mph(30)) / M_PER_DEG_LNG };

describe('the step log', () => {
  const at = (ts: number, steps?: number) => ({ ts, ...(steps === undefined ? {} : { steps }) });

  test('keeps the counts of the last 20 s; a row without a count changes nothing', () => {
    let log: StepMark[] = [];
    for (let i = 0; i <= 25; i += 1) log = noteSteps(log, at(T0 + i * 1000, i));
    expect(log[0]).toEqual({ ts: T0 + 5000, steps: 5 });
    expect(noteSteps(log, at(T0 + 26_000))).toEqual(log);
  });

  test('a lower count is a pedometer that started again: the log starts from it', () => {
    const log = noteSteps([{ ts: T0, steps: 40 }], at(T0 + 1000, 2));
    expect(log).toEqual([{ ts: T0 + 1000, steps: 2 }]);
  });

  test('a walk is 15 steps between the oldest and newest count; since is the last row before the first step', () => {
    expect(stepWalk([{ ts: T0, steps: 3 }, { ts: T0 + 19_000, steps: 17 }])).toBeNull();
    expect(
      stepWalk([
        { ts: T0, steps: 3 },
        { ts: T0 + 1000, steps: 3 },
        { ts: T0 + 2000, steps: 5 },
        { ts: T0 + 9000, steps: 18 },
      ])
    ).toEqual({ since: T0 + 1000 });
  });
});

describe('the step walk', () => {
  /** Stopped after the drive, the count rising 2 a row from `from` rows into the stop. */
  const stopWithSteps = (n: number, from = 2, perRow = 2) => ({ n, mps: 0, over: (i: number) => ({ steps: Math.max(0, i - from) * perRow }) });

  test('15 steps in 20 s once nothing has been over 3 mph for 15 s: a walking end cut at the last movement', async () => {
    const h = await started();
    const rows = path(T0, DRIVE, stopWithSteps(30));
    // The last fast row is at T0 + 59 s: the 15th still row after it (T0 + 74 s) is the first calm one.
    await feed(h, rows.slice(0, 74));
    expect(status(h)).toBe('recording');
    await feed(h, rows.slice(74, 75));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', cut: true, endedAt: DRIVE_END });
  });

  test('steps while the car still moves over 3 mph end nothing', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, { n: 60, mps: mph(4), over: (i) => ({ steps: i * 2 }) }));
    expect(status(h)).toBe('recording');
  });

  test('fewer than 15 steps in any 20 s end nothing (the still end comes later)', async () => {
    const h = await started();
    // One step every 2 s: at most 10 in 20 s.
    await feed(h, path(T0, DRIVE, { n: 120, mps: 0, over: (i) => ({ steps: Math.floor(i / 2) }) }));
    expect(status(h)).toBe('recording');
  });

  test('a fast fix in the last 15 s holds it', async () => {
    const h = await started();
    // Stopped with steps, but a trusted 4 mph fix every 10 s.
    await feed(h, path(T0, DRIVE, { n: 60, mps: 0, over: (i) => ({ steps: i * 2, ...(i % 10 === 0 ? { speed: mph(4) } : {}) }) }));
    expect(status(h)).toBe('recording');
  });

  test('a fast fix with a poor speed accuracy does not hold it', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, { n: 40, mps: 0, over: (i) => ({ steps: i * 2, ...(i % 10 === 0 ? { speed: mph(4), speedAcc: 5 } : {}) }) }));
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END });
  });

  test('a pedometer that starts again is no walk by itself', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, { n: 60, mps: 0, over: (i) => ({ steps: i < 20 ? 200 : i < 21 ? 0 : 1 }) }));
    expect(status(h)).toBe('recording');
  });

  test('never while a Start-card drive still waits', async () => {
    const h = await started({ holdEnds: () => true });
    await feed(h, path(T0, DRIVE, stopWithSteps(60)));
    expect(status(h)).toBe('recording');
  });

  test('a drive that never reached driving speed: only once it is 10 min old (W2)', async () => {
    const h = await started();
    // 7 mph: movement, never driving speed; then stopped with steps.
    const rows = path(T0, { n: 40, mps: mph(7) }, stopWithSteps(40));
    await feed(h, rows);
    expect(status(h)).toBe('recording');
    expect(rows.at(-1)!.ts + 1000 - T0).toBeLessThan(ON_FOOT_DROP_MS);
  });

  test('replayed rows end it the same', async () => {
    const h = await started();
    await feed(h, path(T0, DRIVE, stopWithSteps(30)), true);
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: DRIVE_END });
  });
});

describe('the known parking spot', () => {
  const spots = [PARKED];
  /** Stopped where the drive ended for `n` rows. */
  const stopped = (n: number) => ({ n, mps: 0 });
  /** A report arriving after `n` rows have been fed (the row clock is then the `n`th row's end). */
  const report = (h: H, a: MotionActivity) => h.engine.dispatch({ type: 'motion', activity: a, ts: T0 });
  /** The drive, then stopped, with a confident still report arriving 5 s into the stop (T0 + 65 s). */
  async function parkedWithStill(h: H, n: number): Promise<FeatureRow[]> {
    const rows = path(T0, DRIVE, stopped(n));
    await feed(h, rows.slice(0, 65));
    await report(h, act('stationary', T0 + 64_000));
    return rows;
  }

  test('a minute stopped within 75 m of a spot, a confident still report since the stop: a still end cut at the stop', async () => {
    const h = await started({ parkingSpots: () => spots });
    const rows = await parkedWithStill(h, 90);
    // The last fast row is at T0 + 59 s: 60 still rows after it (to T0 + 119 s) end it.
    await feed(h, rows.slice(65, 119));
    expect(status(h)).toBe('recording');
    await feed(h, rows.slice(119, 120));
    expect(status(h)).toBe('idle');
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', cut: true, endedAt: DRIVE_END });
  });

  test('no reports at all: no parking end (the 5-min still end remains)', async () => {
    const h = await started({ parkingSpots: () => spots });
    await feed(h, path(T0, DRIVE, stopped(200)));
    expect(status(h)).toBe('recording');
  });

  test('a car standing at a light near a past end (confident automotive, stationary included): no end', async () => {
    const h = await started({ parkingSpots: () => spots });
    const rows = path(T0, DRIVE, stopped(200));
    await feed(h, rows.slice(0, 65));
    await report(h, act('automotive', T0 + 64_000));
    await feed(h, rows.slice(65));
    expect(status(h)).toBe('recording');
  });

  test('an in-a-vehicle report after the still one holds it until another still report', async () => {
    const h = await started({ parkingSpots: () => spots });
    const rows = await parkedWithStill(h, 200);
    await feed(h, rows.slice(65, 100));
    await report(h, act('automotive', T0 + 99_000, 'medium'));
    await feed(h, rows.slice(100, 150));
    expect(status(h)).toBe('recording');
    await report(h, act('walking', T0 + 149_000));
    // The walking report (T0 + 150 s) is also a walk: the walking end may come first; either way the drive ends cut at the stop.
    await feed(h, rows.slice(150, 151));
    expect(h.finalized[0]).toMatchObject({ cut: true, endedAt: DRIVE_END });
  });

  test('a still report from before the stop, or a low-confidence one, is no evidence', async () => {
    const before = harness({ parkingSpots: () => spots });
    await before.engine.dispatch({ type: 'motion', activity: act('stationary', T0 - 30_000), ts: T0 - 30_000 });
    await before.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    await feed(before, path(T0, DRIVE, stopped(120)));
    expect(status(before)).toBe('recording');
    const low = await started({ parkingSpots: () => spots });
    const rows = path(T0, DRIVE, stopped(120));
    await feed(low, rows.slice(0, 65));
    await report(low, act('stationary', T0 + 64_000, 'low'));
    await feed(low, rows.slice(65));
    expect(status(low)).toBe('recording');
  });

  test('a spot 70 m off counts, 80 m off does not', async () => {
    const off = (m: number) => [{ lat: PARKED.lat, lng: PARKED.lng + m / M_PER_DEG_LNG }];
    const near = await started({ parkingSpots: () => off(70) });
    const rows = await parkedWithStill(near, 61);
    await feed(near, rows.slice(65));
    expect(status(near)).toBe('idle');
    const far = await started({ parkingSpots: () => off(80) });
    const farRows = await parkedWithStill(far, 120);
    await feed(far, farRows.slice(65));
    expect(status(far)).toBe('recording');
  });

  test('no spots, nothing', async () => {
    const h = await started();
    const rows = await parkedWithStill(h, 120);
    await feed(h, rows.slice(65));
    expect(status(h)).toBe('recording');
  });

  test('never on replayed rows, while a Start-card drive waits, or before driving speed', async () => {
    const replayed = await started({ parkingSpots: () => spots });
    const rows = path(T0, DRIVE, stopped(120));
    await feed(replayed, rows.slice(0, 65), true);
    await report(replayed, act('stationary', T0 + 64_000));
    await feed(replayed, rows.slice(65), true);
    expect(status(replayed)).toBe('recording');
    const held = await started({ parkingSpots: () => spots, holdEnds: () => true });
    const heldRows = await parkedWithStill(held, 120);
    await feed(held, heldRows.slice(65));
    expect(status(held)).toBe('recording');
    const slow = await started({ parkingSpots: () => [{ lat: LAT, lng: LNG + (40 * mph(7)) / M_PER_DEG_LNG }] });
    const slowRows = path(T0, { n: 40, mps: mph(7) }, stopped(120));
    await feed(slow, slowRows.slice(0, 45));
    await report(slow, act('stationary', T0 + 44_000));
    await feed(slow, slowRows.slice(45));
    expect(status(slow)).toBe('recording');
  });

  test('a tick ends it too', async () => {
    const h = await started({ parkingSpots: () => spots });
    await parkedWithStill(h, 30);
    await h.engine.dispatch({ type: 'tick', ts: T0 + 121_000 });
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', endedAt: DRIVE_END });
  });
});

describe('vehicleReading', () => {
  test('automotive at medium or more is a vehicle, any other type at medium or more clear, low confidence or an exit unsure', () => {
    expect(vehicleReading(act('automotive', T0, 'medium'))).toBe('vehicle');
    expect(vehicleReading(act('stationary', T0))).toBe('clear');
    expect(vehicleReading(act('unknown', T0, 'medium'))).toBe('clear');
    expect(vehicleReading(act('automotive', T0, 'low'))).toBe('unsure');
    expect(vehicleReading(act('stationary', T0, 'low'))).toBe('unsure');
    expect(vehicleReading({ ...act('automotive', T0), exit: true })).toBe('unsure');
  });
});

describe('the car link', () => {
  test('gone 15 s with nothing over 3 mph since: a still end cut at the last movement', async () => {
    let gone: number | null = null;
    const h = await started({ carGoneSince: () => gone });
    const rows = path(T0, DRIVE, { n: 60, mps: 0 });
    await feed(h, rows.slice(0, 65));
    // The link goes at T0 + 65 s (stopped since T0 + 60 s): 15 s later, at the row ending T0 + 80 s, the drive ends.
    gone = T0 + 65_000;
    await feed(h, rows.slice(65, 79));
    expect(status(h)).toBe('recording');
    await feed(h, rows.slice(79, 80));
    expect(h.finalized[0]).toMatchObject({ endCause: 'stopped', cut: true, endedAt: DRIVE_END });
  });

  test('a disconnect while the car moves does nothing, nor one from before the drive', async () => {
    const moving = await started({ carGoneSince: () => T0 + 50_000 });
    await feed(moving, path(T0, DRIVE, { n: 60, mps: 0 }));
    expect(status(moving)).toBe('recording');
    const old = await started({ carGoneSince: () => T0 - 1000 });
    await feed(old, path(T0, DRIVE, { n: 60, mps: 0 }));
    expect(status(old)).toBe('recording');
  });

  test('a reconnect inside the 15 s cancels it', async () => {
    let gone: number | null = null;
    const h = await started({ carGoneSince: () => gone });
    const rows = path(T0, DRIVE, { n: 90, mps: 0 });
    await feed(h, rows.slice(0, 65));
    gone = T0 + 65_000;
    await feed(h, rows.slice(65, 75));
    gone = null;
    await feed(h, rows.slice(75, 120));
    expect(status(h)).toBe('recording');
  });

  test('never while a Start-card drive waits, nor on replayed rows', async () => {
    const held = await started({ carGoneSince: () => T0 + 61_000, holdEnds: () => true });
    await feed(held, path(T0, DRIVE, { n: 60, mps: 0 }));
    expect(status(held)).toBe('recording');
    const replayed = await started({ carGoneSince: () => T0 + 61_000 });
    await feed(replayed, path(T0, DRIVE, { n: 60, mps: 0 }), true);
    expect(status(replayed)).toBe('recording');
  });
});
