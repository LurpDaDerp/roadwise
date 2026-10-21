import { createDetectors } from '@/core/detectors';
import { limit, mph, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { AlertEvent, EngineDeps, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { CHECKPOINT_ROWS, createEngine } from '@/core/engine/machine';
import { createSession, stillWithoutFix } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';

interface Harness {
  engine: ReturnType<typeof createEngine>;
  alerts: AlertEvent[];
  checkpoints: Readonly<TripSession>[];
  finalized: Readonly<TripSession>[];
  errors: unknown[];
  snapshots: EngineSnapshot[];
  checkpointFails: number;
  finalizeFails: boolean;
}

function harness(over: Partial<EngineDeps> = {}): Harness {
  let n = 0;
  const h: Harness = { alerts: [], checkpoints: [], finalized: [], errors: [], snapshots: [], checkpointFails: 0, finalizeFails: false } as unknown as Harness;
  h.engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({ callActive: false, switchSignal: 'reliable', lockDelayMs: null, platform: 'android' }),
    onAlert: (a) => h.alerts.push(a),
    onCheckpoint: async (s) => {
      if (h.checkpointFails > 0) {
        h.checkpointFails -= 1;
        throw new Error('checkpoint failed');
      }
      h.checkpoints.push(s);
    },
    onFinalize: async (s) => {
      if (h.finalizeFails) throw new Error('finalize failed');
      h.finalized.push(s);
    },
    onError: (e) => h.errors.push(e),
    ...over,
  });
  h.engine.subscribe((s) => h.snapshots.push(s));
  return h;
}

const feed = async (h: Harness, rows: FeatureRow[]) => {
  for (const r of rows) await h.engine.dispatch({ type: 'row', row: r });
};
/** Rows after the warm-up: row i sits at T0 + 31 s + i. */
const after = (n: number, over: Partial<FeatureRow> | ((i: number) => Partial<FeatureRow>)) =>
  seq([n, (i) => ({ ...(typeof over === 'function' ? over(i) : over), ts: T0 + 31_000 + i * 1000 })]);

test('a drive starts only on `start` and ends on `end`, handing the finalizer one closed session', async () => {
  const h = harness();
  await feed(h, [row({}, 0)]);
  expect(h.engine.snapshot().status).toBe('idle');
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'id1', startedAt: T0 });
  await feed(h, seq([5, { speed: mph(30) }]));
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: true, limitMph: 35, lockedOut: true, stopped: false });
  await h.engine.dispatch({ type: 'end', ts: T0 + 5000 });
  expect(h.engine.snapshot().status).toBe('idle');
  expect(h.finalized).toHaveLength(1);
  expect(h.finalized[0]).toMatchObject({ clientTripId: 'id1', endedAt: T0 + 5000, endCause: 'manual', rowsCount: 5 });
  // The trip row is written at start (an empty checkpoint) and the tail before finalize.
  expect(h.checkpoints).toHaveLength(2);
  expect(h.checkpoints[0]).toMatchObject({ clientTripId: 'id1', rowsCount: 0, pending: [] });
  expect(h.snapshots.map((s) => s.status)).toEqual(expect.arrayContaining(['recording', 'finalizing', 'idle']));
  // A second start is a new drive with a fresh id; the old one changes nothing.
  await h.engine.dispatch({ type: 'start', ts: T0 + 6000, continues: false });
  expect(h.engine.snapshot().clientTripId).toBe('id2');
});

test('an on-foot report at 40 mph is cancelled by driving; one at a stop ends the drive 20 s after it arrives, cut at the last movement', async () => {
  const w = harness();
  await w.engine.dispatch({ type: 'start', ts: T0, continues: false });
  await feed(w, seq([3, { speed: mph(40) }]));
  await w.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 2500 }, ts: T0 + 3000 });
  await feed(w, seq([2, (i) => ({ speed: mph(40), ts: T0 + 3000 + i * 1000 })]));
  await feed(w, seq([25, (i) => ({ speed: 0, ts: T0 + 5000 + i * 1000 })]));
  expect(w.engine.snapshot().status).toBe('recording'); // the misfire at 40 mph was cancelled
  await w.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 29_000 }, ts: T0 + 30_000 });
  await feed(w, seq([20, (i) => ({ speed: 0, ts: T0 + 30_000 + i * 1000 })]));
  expect(w.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 5000, cut: true });
});

test('alerts: one shown speeding alert per episode (its repeats are sounded only), the pickup and the 15-s handling alert, a hard brake the row the GPS confirms it', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  // Forward extremes on the first rows: the axis is learned, so the 47 → 30 mph step is not a GPS-only brake.
  await feed(h, after(10, { speed: mph(47), aLonMax: 0.02, aLonMin: -0.02 }));
  await feed(h, seq([10, (i) => ({ speed: mph(30), ts: T0 + 41_000 + i * 1000 })]));
  expect(h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true)).toHaveLength(1);
  expect(h.alerts[0]).toMatchObject({ type: 'speeding', tier: 'moderate', at: T0 + 31_000 });
  expect(h.alerts[0]!.repeat).toBeUndefined();
  expect(h.snapshots.some((s) => s.speedingTier === 'moderate')).toBe(true);
  const phoneRows = seq([20, (i) => ({ speed: mph(30), handlingScore: 0.9, gravityStability: 0.5, ts: T0 + 51_000 + i * 1000 })]);
  await feed(h, phoneRows);
  await feed(h, seq([3, (i) => ({ speed: mph(30), ts: T0 + 71_000 + i * 1000 })]));
  const phone = h.alerts.filter((a) => a.type.startsWith('phone'));
  expect(phone.map((a) => a.type)).toEqual(['phone_pickup', 'phone_handling']);
  expect(phone[1]!.at - phone[0]!.at).toBeGreaterThanOrEqual(15_000 - 2000);
  // A brake is told on the row the GNSS confirms it (its peak row here), not after the 2-s veto hold.
  await feed(h, seq([5, (i) => ({ speed: mph(35), ts: T0 + 74_000 + i * 1000 })]));
  await feed(h, [row({ speed: mph(25), aLonMin: -0.35, ts: T0 + 79_000 }), ...seq([4, (i) => ({ speed: mph(25), ts: T0 + 80_000 + i * 1000 })])]);
  expect(h.alerts.at(-1)).toMatchObject({ type: 'hard_brake', tier: 'minor', points: 8, at: T0 + 79_000 });
  expect(h.engine.snapshot().lastAlert?.type).toBe('hard_brake');
  await h.engine.dispatch({ type: 'end', ts: T0 + 90_000 });
  expect(h.finalized[0]!.events.map((e) => e.type).sort()).toEqual(['hard_brake', 'phone_handling', 'phone_pickup', 'speeding']);
  // The fixture rows do not move (one position), so the distance accumulators stay at zero here;
  // `session.test.ts` covers the safe-distance split.
  expect(h.finalized[0]!.rowsCount).toBe(53);
});

test('checkpoints every 30 rows and clears the pending rows; a failed checkpoint keeps them for the next', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  h.checkpoints.length = 0;
  h.checkpointFails = 1;
  await feed(h, seq([CHECKPOINT_ROWS, { speed: mph(30) }]));
  expect(h.errors).toHaveLength(1);
  expect(h.engine.session()?.pending).toHaveLength(CHECKPOINT_ROWS);
  await feed(h, seq([CHECKPOINT_ROWS, (i) => ({ speed: mph(30), ts: T0 + (CHECKPOINT_ROWS + i) * 1000 })]));
  expect(h.checkpoints).toHaveLength(1);
  expect(h.checkpoints[0]!.pending).toHaveLength(2 * CHECKPOINT_ROWS);
  expect(h.engine.session()?.pending).toHaveLength(0);
  expect(h.engine.session()?.checkpointTs).toBe(T0 + (2 * CHECKPOINT_ROWS - 1) * 1000);
});

test('a finalizer that throws is reported and the engine is idle again for the next drive', async () => {
  const h = harness();
  h.finalizeFails = true;
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  await feed(h, seq([2, { speed: mph(30) }]));
  await h.engine.dispatch({ type: 'end', ts: T0 + 2000 });
  expect(h.engine.snapshot().status).toBe('idle');
  expect(h.errors).toHaveLength(1);
});

test('adopt continues a rebuilt drive only while idle; stale and duplicate rows are ignored', async () => {
  const h = harness();
  const session = { ...createDetectorsSession(), clientTripId: 'old', startedAt: T0 - 60_000, rowsCount: 10, lastRowTs: T0 - 1000 };
  await h.engine.dispatch({ type: 'adopt', trip: { session, detectors: createDetectors(() => 'x') }, ts: T0 });
  expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'old', startedAt: T0 - 60_000 });
  await feed(h, [row({ speed: mph(30), ts: T0 - 5000 })]);
  expect(h.engine.session()?.rowsCount).toBe(10);
  await h.engine.dispatch({ type: 'adopt', trip: { session: { ...session, clientTripId: 'other' }, detectors: createDetectors(() => 'y') }, ts: T0 });
  expect(h.engine.snapshot().clientTripId).toBe('old');
});

function createDetectorsSession(): TripSession {
  return createSession({ clientTripId: 'x', startedAt: T0 });
}

test('stillWithoutFix: a still phone with no fix', () => {
  expect(stillWithoutFix(row({ gnssValid: false, gravityStability: 0.99 }))).toBe(true);
  expect(stillWithoutFix(row({ gnssValid: false, gravityStability: 0.99, aLonMax: 0.2 }))).toBe(false);
  expect(stillWithoutFix(row({ gnssValid: true }))).toBe(false);
});

describe('the warm-up in a live drive (Start Drive at any speed)', () => {
  const handled = { handlingScore: 0.9, gravityStability: 0.5, orientationDelta: 0.2 };
  const at = (fromS: number, n: number, over: Partial<FeatureRow>) => seq([n, (i) => ({ ...over, ts: T0 + (fromS + i) * 1000 })]);
  async function drive(continues: boolean, rows: FeatureRow[]): Promise<Readonly<TripSession>> {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, continues });
    await feed(h, rows);
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    return h.finalized[0]!;
  }
  const types = (s: Readonly<TripSession>) => s.events.map((e) => e.type);

  test('a start at 37 mph: three handling rows at +10 s are a pickup', async () => {
    const s = await drive(false, [...at(0, 10, { speed: mph(37) }), ...at(10, 3, { speed: mph(37), ...handled }), ...at(13, 5, { speed: mph(37) })]);
    expect(s.warmup).toMatchObject({ decided: true, endsAt: T0 });
    expect(types(s)).toEqual(['phone_pickup']);
  });

  test('the same rows on a stopped start (first reading 0 mph) are inside the 30 s: no pickup', async () => {
    const s = await drive(false, [...at(0, 5, { speed: 0 }), ...at(5, 5, { speed: mph(40) }), ...at(10, 3, { speed: mph(40), ...handled }), ...at(13, 5, { speed: mph(40) })]);
    expect(s.warmup).toMatchObject({ decided: true, endsAt: T0 + 30_000 });
    expect(types(s)).toEqual([]);
  });

  test('a restart (continues) that starts stopped: three handling rows at 35 mph at +5 s are a pickup', async () => {
    const s = await drive(true, [...at(0, 2, { speed: 0 }), ...at(2, 3, { speed: mph(35) }), ...at(5, 3, { speed: mph(35), ...handled }), ...at(8, 5, { speed: mph(35) })]);
    expect(s.warmup).toMatchObject({ continues: true, endsAt: T0 });
    expect(types(s)).toEqual(['phone_pickup']);
  });

  test('speeding counts from the first trusted reading of a moving start, and only after 30 s on a stopped one', async () => {
    const moving = await drive(false, [...at(0, 20, { speed: mph(55) }), ...at(20, 10, { speed: mph(30) })]);
    expect(moving.events.filter((e) => e.type === 'speeding').map((e) => [e.startedAt, e.durationS])).toEqual([[T0, 20]]);
    const stopped = await drive(false, [...at(0, 1, { speed: 0 }), ...at(1, 39, { speed: mph(55) }), ...at(40, 10, { speed: mph(30) })]);
    expect(stopped.events.filter((e) => e.type === 'speeding').map((e) => [e.startedAt, e.durationS])).toEqual([[T0 + 30_000, 10]]);
  });

  test('a hard brake 10 s into a moving start counts; on a stopped start it does not', async () => {
    const brake = (lead: FeatureRow[]) => [
      ...lead,
      ...at(5, 5, { speed: mph(35) }),
      ...at(10, 1, { speed: mph(25), aLonMin: -0.5 }),
      ...at(11, 5, { speed: mph(25) }),
    ];
    expect(types(await drive(false, brake(at(0, 5, { speed: mph(35) }))))).toEqual(['hard_brake']);
    expect(types(await drive(false, brake(at(0, 5, { speed: 0 }))))).toEqual([]);
  });

  test('an untrusted first reading (speedAcc 3) decides nothing; the next trusted one does', async () => {
    const s = await drive(false, [...at(0, 3, { speed: mph(40), speedAcc: 3 }), ...at(3, 10, { speed: mph(40) })]);
    expect(s.warmup).toMatchObject({ decided: true, endsAt: T0 + 3000 });
  });
});

test('S3: a row that lost its fix keeps the last shown speed, never "—"; stopped reads the raw fix', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  await feed(h, after(2, { speed: mph(30) }));
  const lost = { gnssValid: false, speed: -1, hAcc: -1 };
  const at = (i: number) => ({ ...lost, ts: T0 + 32_000 + i * 1000 });
  await feed(h, [row(at(1), 0)]);
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: true, speedMps: mph(30), stopped: false });
  await feed(h, [row(at(3), 0)]);
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: true, speedMps: mph(30) });
  await feed(h, [row(at(4), 0)]);
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: true, speedMps: mph(30) });
  // A fix back resets the hold to the new speed.
  await feed(h, [row({ speed: mph(20), ts: T0 + 37_000 }, 0)]);
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: true, speedMps: mph(20) });
  await h.engine.dispatch({ type: 'end', ts: T0 + 38_000 });
});

test('a `speed` fix moves the shown speed at once, only while recording; the rows and the detectors keep their own fix', async () => {
  const h = harness();
  h.engine.speed({ at: T0, mps: mph(30), acc: 0.5, hAcc: 5 });
  expect(h.engine.snapshot()).toMatchObject({ speedKnown: false, speedAt: null, rowSpeedMps: null });
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  const published = h.snapshots.length;
  h.engine.speed({ at: T0 + 31_200, mps: mph(30), acc: 0.5, hAcc: 5 });
  expect(h.snapshots.length).toBe(published + 1);
  expect(h.engine.snapshot()).toMatchObject({ speedMps: mph(30), speedAt: T0 + 31_200, rowSpeedMps: null });
  // A row with its own (different) fix: the detectors and `stopped` read it; the screen keeps the event's.
  await feed(h, after(1, { speed: mph(4) }));
  expect(h.engine.snapshot()).toMatchObject({ speedMps: mph(30), speedAt: T0 + 31_200, rowSpeedMps: mph(4), stopped: true });
  // A fix that measures nothing, or one no newer, publishes nothing.
  const before = h.snapshots.length;
  h.engine.speed({ at: T0 + 31_200, mps: mph(50), acc: 0.5, hAcc: 5 });
  expect(h.snapshots.length).toBe(before);
  await h.engine.dispatch({ type: 'end', ts: T0 + 33_000 });
  h.engine.speed({ at: T0 + 34_000, mps: mph(30), acc: 0.5, hAcc: 5 });
  expect(h.engine.snapshot()).toMatchObject({ status: 'idle', speedKnown: false });
});

describe('the driving screen contract', () => {
  test('courseDeg: the GPS course at 5 mph or more, held while slower, without a course or a fix; null when not recording', async () => {
    const h = harness();
    expect(h.engine.snapshot().courseDeg).toBeNull();
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    expect(h.engine.snapshot().courseDeg).toBeNull();
    // Slower than 5 mph: no course yet, whatever the fix says.
    await feed(h, [row({ speed: mph(4), course: 45, ts: T0 + 1000 })]);
    expect(h.engine.snapshot().courseDeg).toBeNull();
    await feed(h, [row({ speed: mph(5), course: 45, ts: T0 + 2000 })]);
    expect(h.engine.snapshot().courseDeg).toBe(45);
    // Held: a crawl, an unknown course (-1), a lost fix, an unknown speed.
    await feed(h, [row({ speed: mph(2), course: 200, ts: T0 + 3000 })]);
    await feed(h, [row({ speed: mph(30), course: -1, ts: T0 + 4000 })]);
    await feed(h, [row({ speed: mph(30), course: 300, gnssValid: false, ts: T0 + 5000 })]);
    await feed(h, [row({ speed: -1, course: 300, ts: T0 + 6000 })]);
    expect(h.engine.snapshot().courseDeg).toBe(45);
    await feed(h, [row({ speed: mph(30), course: 359.5, ts: T0 + 7000 })]);
    expect(h.engine.snapshot().courseDeg).toBe(359.5);
    await h.engine.dispatch({ type: 'end', ts: T0 + 8000 });
    expect(h.engine.snapshot().courseDeg).toBeNull();
    // The next drive starts without one.
    await h.engine.dispatch({ type: 'start', ts: T0 + 9000, continues: false });
    expect(h.engine.snapshot().courseDeg).toBeNull();
  });

  test('speedingRatio and speedingOver: the row speed over the posted limit it is judged on; over from the points line', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    // In the warm-up (a start from a standstill) the detector cannot use the row: no ratio.
    await feed(h, [row({ speed: 0, ts: T0 + 1000 }), row({ speed: mph(42), ts: T0 + 2000 })]);
    expect(h.engine.snapshot()).toMatchObject({ speedingRatio: null, speedingOver: false });
    // 35 on a 35: at the limit, not over the line (L + T = 39).
    await feed(h, after(1, { speed: mph(35) }));
    expect(h.engine.snapshot().speedingRatio).toBeCloseTo(1, 9);
    expect(h.engine.snapshot().speedingOver).toBe(false);
    await feed(h, seq([1, { speed: mph(39), ts: T0 + 32_000 }]));
    expect(h.engine.snapshot().speedingRatio).toBeCloseTo(39 / 35, 9);
    expect(h.engine.snapshot().speedingOver).toBe(false);
    await feed(h, seq([1, { speed: mph(39.5), ts: T0 + 33_000 }]));
    expect(h.engine.snapshot().speedingRatio).toBeCloseTo(39.5 / 35, 9);
    expect(h.engine.snapshot().speedingOver).toBe(true);
    // An untrusted speed, a poor fix: not a usable row.
    await feed(h, seq([1, { speed: mph(45), speedAcc: 3, ts: T0 + 34_000 }]));
    expect(h.engine.snapshot()).toMatchObject({ speedingRatio: null, speedingOver: false });
    await feed(h, seq([1, { speed: mph(45), hAcc: 40, ts: T0 + 35_000 }]));
    expect(h.engine.snapshot()).toMatchObject({ speedingRatio: null, speedingOver: false });
    await h.engine.dispatch({ type: 'end', ts: T0 + 36_000 });
    expect(h.engine.snapshot()).toMatchObject({ speedingRatio: null, speedingOver: false, lastDeduction: null });
  });

  test('a class default is shown on the sign but never tints: no ratio', async () => {
    const h = harness({ limits: { lookup: () => limit(mph(35), 'statutory'), prefetch: () => {} } });
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    await feed(h, after(2, { speed: mph(50) }));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: 35, speedingRatio: null, speedingOver: false });
  });
});

describe('speeding alerts and deductions', () => {
  /** After the warm-up: row i at T0 + 31 s + i. */
  // Forward extremes on every row: the axis is learned, so a sharp slowdown is never a GPS-only brake.
  const over = (n: number, speedMph: number, from = 0) =>
    seq([n, (i) => ({ speed: mph(speedMph), aLonMax: 0.02, aLonMin: -0.02, ts: T0 + 31_000 + (from + i) * 1000 })]);
  async function started(): Promise<Harness> {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    return h;
  }
  const rowOf = (at: number) => (at - T0 - 31_000) / 1000;

  test('the first over row alerts at once; repeats follow while over, the grace end deducts, later repeats deduct what accrued', async () => {
    const h = await started();
    await feed(h, over(20, 47));
    const speeding = h.alerts.filter((a) => a.type === 'speeding');
    // 47 on a 35 is 8 past the line: repeats every 8 / 2.6 × 0.85^(elapsed / 10) s (about 3 s here).
    expect(speeding.map((a) => [rowOf(a.at), a.repeat === true, a.points ?? 0])).toEqual([
      [0, false, 0],
      [3, true, 0],
      [5, true, 1],
      [8, true, 4],
      [11, true, 4],
      [14, true, 4],
      [17, true, 5],
    ]);
    // The repeats never touch lastAlert (no banner); the deductions are the HUD's lastDeduction.
    expect(h.engine.snapshot().lastAlert).toMatchObject({ type: 'speeding', at: T0 + 31_000 });
    expect(h.engine.snapshot().lastDeduction).toEqual({ key: `${speeding[0]!.id}:5`, points: 5, at: T0 + 31_000 + 17_000 });
    const keys = new Set(h.snapshots.map((s) => s.lastDeduction?.key).filter((k) => k !== undefined));
    expect(keys.size).toBe(5);
  });

  test('back under the line within the grace: one alert, nothing deducted', async () => {
    const h = await started();
    await feed(h, [...over(5, 45), ...over(10, 30, 5)]);
    expect(h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true)).toHaveLength(1);
    expect(h.alerts.some((a) => a.points !== undefined)).toBe(false);
    expect(h.engine.snapshot().lastDeduction).toBeNull();
  });

  test('hovering at the line is one episode: no new alert, repeats only on rows over the line; 5 s under the buffer ends it', async () => {
    const h = await started();
    // 2 over, 10 hovering at 37 (L + T − 2), 2 over: one alert; nothing sounds while under.
    await feed(h, [...over(2, 41), ...over(10, 37, 2), ...over(2, 41, 12)]);
    const shown = () => h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true);
    expect(shown()).toHaveLength(1);
    const sounded = h.alerts.filter((a) => a.type === 'speeding').map((a) => rowOf(a.at));
    // 41 is 2 past the line: 8 / 1.4 s = 5.7 s; the row back over at 12 is due at once.
    expect(sounded).toEqual([0, 12]);
    expect(h.snapshots.at(-1)!.speedingOver).toBe(true);
    // 5 rows under 37 end the episode; the next over row is a new alert.
    await feed(h, [...over(5, 30, 14), ...over(1, 41, 19)]);
    expect(shown()).toHaveLength(2);
  });

  test('the cadence quickens the further over and the longer it lasts: repeats never under 2 s apart, the grace end sounds at once', async () => {
    const h = await started();
    await feed(h, over(60, 70));
    const at = h.alerts.filter((a) => a.type === 'speeding').map((a) => rowOf(a.at));
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // 31 past the line: 8 / 7.2 s ≈ 1.1, held at the 2-s floor (the grace end at row 5 sounds at once).
    expect(gaps.every((g) => g >= 1 && g <= 2)).toBe(true);
    expect(gaps.filter((g) => g === 1)).toHaveLength(1);
  });

  test('a speeding repeat with no whole point accrued since the last deduction is the chime', async () => {
    const h = await started();
    // 39.6 on a 35: 0.6 past the line: 0.09 a second accrues, under a point between most repeats.
    await feed(h, over(40, 39.6));
    const repeats = h.alerts.filter((a) => a.type === 'speeding' && a.repeat === true);
    expect(repeats.some((a) => a.points === undefined && rowOf(a.at) > 5)).toBe(true);
    for (const a of repeats) if (a.points !== undefined) expect(a.points).toBeGreaterThanOrEqual(1);
  });
});

describe('deductions from the instant and phone alerts', () => {
  const handled = { handlingScore: 0.9, gravityStability: 0.5 };
  const at = (fromS: number, n: number, over: Partial<FeatureRow>) => seq([n, (i) => ({ ...over, ts: T0 + 31_000 + (fromS + i) * 1000 })]);

  // A 65 road: 50 mph is no speeding.
  const road65 = { limits: { lookup: () => limit(mph(65)), prefetch: () => {} } };

  test('a pickup at 50 mph costs 32 × 2; the handling alert the units at that speed; each with the points-lost cue and a new key', async () => {
    const h = harness(road65);
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    await feed(h, [...at(0, 5, { speed: mph(50) }), ...at(5, 30, { speed: mph(50), ...handled }), ...at(35, 3, { speed: mph(50) })]);
    const phone = h.alerts.filter((a) => a.type.startsWith('phone'));
    expect(phone.map((a) => [a.type, a.points])).toEqual([
      ['phone_pickup', 64],
      ['phone_handling', 16],
    ]);
    const keys = h.snapshots.map((s) => s.lastDeduction?.key).filter((k): k is string => k !== undefined);
    expect(new Set(keys).size).toBe(2);
  });

  test('a hard brake on the row the speeding grace ends: each alert keeps its own points, the driving screen gets their sum as one deduction', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    // 60 on a 35 for 5 rows, then a hard brake to 50 on the 6th over row (still over the line, 39):
    // the brake (8) and the grace's end (11 past the line for 1 charged second: 2) on one row.
    const steady = { aLonMax: 0.02, aLonMin: -0.02 };
    await feed(h, [...at(0, 5, { speed: mph(60), ...steady }), ...at(5, 1, { speed: mph(50), aLonMax: 0.02, aLonMin: -0.35 }), ...at(6, 4, { speed: mph(50), ...steady })]);
    const brakeRow = T0 + 31_000 + 5000;
    const onRow = h.alerts.filter((a) => a.at === brakeRow);
    expect(onRow.map((a) => [a.type, a.points])).toEqual([
      ['hard_brake', 8],
      ['speeding', 2],
    ]);
    // The state is published once per row: that row's one deduction carries both, under its own key.
    const published = h.snapshots.map((s) => s.lastDeduction).filter((d) => d !== null && d.at === brakeRow);
    expect(new Set(published.map((d) => d!.key)).size).toBe(1);
    expect(published[0]).toMatchObject({ points: 10, at: brakeRow });
    // A later row's deduction stands alone again.
    const later = h.snapshots.map((s) => s.lastDeduction).filter((d) => d !== null && d.at > brakeRow);
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) expect(d!.points).toBe(h.alerts.filter((a) => a.at === d!.at).reduce((sum, a) => sum + (a.points ?? 0), 0));
  });

  test('a pickup stopped in traffic costs 16, with no speed multiplier', async () => {
    const h = harness(road65);
    await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
    await feed(h, [...at(0, 5, { speed: mph(50) }), ...at(5, 3, { speed: 0 }), ...at(8, 4, { speed: 0, ...handled }), ...at(12, 3, { speed: 0 })]);
    expect(h.alerts.find((a) => a.type === 'phone_pickup')).toMatchObject({ points: 16 });
    expect(h.engine.snapshot().lastDeduction).toMatchObject({ points: 16 });
  });
});
