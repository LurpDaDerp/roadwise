import { createDetectors } from '@/core/detectors';
import { limit, mph, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { AlertEvent, EngineDeps, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { CHECKPOINT_ROWS, createEngine, tintRatio } from '@/core/engine/machine';
import { createSession, stillWithoutFix } from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';

interface Harness {
  engine: ReturnType<typeof createEngine>;
  alerts: AlertEvent[];
  checkpoints: Readonly<TripSession>[];
  finalized: Readonly<TripSession>[];
  cancelled: Readonly<TripSession>[];
  errors: unknown[];
  snapshots: EngineSnapshot[];
  checkpointFails: number;
  finalizeFails: boolean;
}

function harness(over: Partial<EngineDeps> = {}): Harness {
  let n = 0;
  const h: Harness = { alerts: [], checkpoints: [], finalized: [], cancelled: [], errors: [], snapshots: [], checkpointFails: 0, finalizeFails: false } as unknown as Harness;
  h.engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({ platform: 'ios' }),
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
    onCancel: async (s) => {
      h.cancelled.push(s);
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
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
  await h.engine.dispatch({ type: 'start', ts: T0 + 6000, origin: 'manual', continues: false });
  expect(h.engine.snapshot().clientTripId).toBe('id2');
});

test('an on-foot report at 40 mph is cancelled by driving; one at a stop ends the drive 10 s after its walk began (WALK_END_S), cut at the last movement', async () => {
  const w = harness();
  await w.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  await feed(w, seq([3, { speed: mph(40) }]));
  await w.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 2500 }, ts: T0 + 3000 });
  await feed(w, seq([2, (i) => ({ speed: mph(40), ts: T0 + 3000 + i * 1000 })]));
  await feed(w, seq([25, (i) => ({ speed: 0, ts: T0 + 5000 + i * 1000 })]));
  expect(w.engine.snapshot().status).toBe('recording'); // the misfire at 40 mph was cancelled
  await w.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 29_000 }, ts: T0 + 30_000 });
  await feed(w, seq([8, (i) => ({ speed: 0, ts: T0 + 30_000 + i * 1000 })]));
  expect(w.finalized).toHaveLength(0); // 9 s after the walk began (29 s): still recording
  await feed(w, seq([1, (i) => ({ speed: 0, ts: T0 + 38_000 + i * 1000 })]));
  expect(w.finalized[0]).toMatchObject({ endCause: 'walking', endedAt: T0 + 5000, cut: true });
});

test('alerts: one shown speeding alert per episode (its repeats are sounded only), a hard brake the row the GPS confirms it, a phone pickup the row it confirms', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  // Forward extremes on the first rows: the axis is learned, so the 47 → 30 mph step is not a GPS-only brake.
  await feed(h, after(10, { speed: mph(47), aLonMax: 0.02, aLonMin: -0.02 }));
  await feed(h, seq([10, (i) => ({ speed: mph(30), ts: T0 + 41_000 + i * 1000 })]));
  expect(h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true)).toHaveLength(1);
  expect(h.alerts[0]).toMatchObject({ type: 'speeding', tier: 'moderate', at: T0 + 31_000 });
  expect(h.alerts[0]!.repeat).toBeUndefined();
  expect(h.snapshots.some((s) => s.speedingTier === 'moderate')).toBe(true);
  // 20 s of a handled phone at 30 mph: the pickup is shown (and shaken) on its third use row, then
  // sounded again, never shown, as its time in hand reaches 15 s.
  const before = h.alerts.length;
  await feed(h, seq([20, (i) => ({ speed: mph(30), handlingScore: 0.9, gravityStability: 0.5, locked: false, screenOn: true, appForeground: false, ts: T0 + 51_000 + i * 1000 })]));
  await feed(h, seq([3, (i) => ({ speed: mph(30), ts: T0 + 71_000 + i * 1000 })]));
  const phone = h.alerts.slice(before).filter((a) => a.type !== 'speeding');
  expect(phone).toEqual([
    { id: expect.any(String), type: 'phone_pickup', tier: 'moderate', at: T0 + 53_000 },
    { id: phone[0]!.id, type: 'phone_pickup', tier: 'moderate', at: T0 + 65_000, repeat: true },
  ]);
  const confirmed = h.snapshots.find((s) => s.lastAlert?.type === 'phone_pickup');
  expect(confirmed).toMatchObject({ lastAlert: phone[0], lastShake: { key: phone[0]!.id, at: T0 + 53_000, tier: 'moderate' } });
  // The repeat is never shown and never shakes.
  expect(h.snapshots.some((s) => s.lastShake?.at === T0 + 65_000 || s.lastAlert?.at === T0 + 65_000)).toBe(false);
  // A brake is told on the row the GNSS confirms it (its peak row here), not after the 2-s veto hold.
  await feed(h, seq([5, (i) => ({ speed: mph(35), ts: T0 + 74_000 + i * 1000 })]));
  await feed(h, [row({ speed: mph(25), aLonMin: -0.35, ts: T0 + 79_000 }), ...seq([4, (i) => ({ speed: mph(25), ts: T0 + 80_000 + i * 1000 })])]);
  expect(h.alerts.at(-1)).toEqual({ id: expect.any(String), type: 'hard_brake', tier: 'minor', at: T0 + 79_000 });
  expect(h.engine.snapshot().lastAlert?.type).toBe('hard_brake');
  await h.engine.dispatch({ type: 'end', ts: T0 + 90_000 });
  expect(h.finalized[0]!.events.map((e) => e.type).sort()).toEqual(['hard_brake', 'phone_pickup', 'speeding']);
  expect(h.finalized[0]!.events.find((e) => e.type === 'phone_pickup')).toMatchObject({ id: phone[0]!.id, startedAt: T0 + 51_000, durationS: 20, tier: 'severe' });
  // The fixture rows do not move (one position), so the distance accumulators stay at zero here;
  // `session.test.ts` covers the safe-distance split.
  expect(h.finalized[0]!.rowsCount).toBe(53);
});

test('a start carries native’s id, the origin, where the start came from and the parked spot; the snapshot says the origin while recording', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0 + 0.4, clientTripId: 'native-id', origin: 'auto', continues: false, startSource: 'motion', startPlace: { lat: 1, lng: 2 } });
  expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'native-id', origin: 'auto', startedAt: T0 });
  expect(h.checkpoints[0]).toMatchObject({ clientTripId: 'native-id', origin: 'auto', startSource: 'motion', startPlace: { lat: 1, lng: 2 } });
  await h.engine.dispatch({ type: 'end', ts: T0 + 1000 });
  expect(h.engine.snapshot().origin).toBeNull();
  await h.engine.dispatch({ type: 'start', ts: T0 + 2000, origin: 'manual', continues: false });
  expect(h.engine.snapshot()).toMatchObject({ clientTripId: 'id1', origin: 'manual' });
  expect(h.engine.session()).toMatchObject({ startSource: null, startPlace: null });
});

describe('cancel ("Not driving?")', () => {
  test('discards the drive: onCancel with the open session, never onFinalize; the engine is idle for the next', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    await feed(h, after(5, { speed: mph(30) }));
    await h.engine.dispatch({ type: 'cancel', ts: T0 + 40_000 });
    expect(h.finalized).toEqual([]);
    expect(h.cancelled).toHaveLength(1);
    expect(h.cancelled[0]).toMatchObject({ clientTripId: 'id1', rowsCount: 5, endedAt: null });
    expect(h.snapshots.map((s) => s.status)).toEqual(expect.arrayContaining(['finalizing']));
    expect(h.engine.snapshot()).toMatchObject({ status: 'idle', clientTripId: null, lastShake: null, lastAlert: null });
    // Only while recording: a cancel while idle does nothing.
    await h.engine.dispatch({ type: 'cancel', ts: T0 + 41_000 });
    expect(h.cancelled).toHaveLength(1);
  });

  test('an onCancel that throws is reported and the engine is still idle', async () => {
    const h = harness({
      onCancel: async () => {
        throw new Error('drop failed');
      },
    });
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
    await h.engine.dispatch({ type: 'cancel', ts: T0 + 1000 });
    expect(h.engine.snapshot().status).toBe('idle');
    expect(h.errors).toHaveLength(1);
  });
});

test('release: the open drive is checkpointed as it stands and let go unended (never finalized or cancelled); only while recording', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
  await feed(h, after(5, { speed: mph(30) }));
  const before = h.checkpoints.length;
  await h.engine.dispatch({ type: 'release', ts: T0 + 10_000 });
  expect(h.checkpoints).toHaveLength(before + 1);
  expect(h.checkpoints.at(-1)).toMatchObject({ clientTripId: 'id1', rowsCount: 5, endedAt: null });
  expect(h.finalized).toEqual([]);
  expect(h.cancelled).toEqual([]);
  expect(h.engine.snapshot()).toMatchObject({ status: 'idle', clientTripId: null });
  await h.engine.dispatch({ type: 'release', ts: T0 + 11_000 });
  expect(h.checkpoints).toHaveLength(before + 1);
});

describe('an end with a cause (native stopped sensing on its own)', () => {
  test('is cut at the last movement with that cause, however recent; without one it is a manual end at the tap', async () => {
    const moving = (n: number, from: number) => seq([n, (i) => ({ speed: mph(30), lng: -122.4194 + (from + i) * 0.0002, ts: T0 + (from + i) * 1000 })]);
    const still = (n: number, from: number) => seq([n, (i) => ({ speed: 0, lng: -122.4194 + from * 0.0002, ts: T0 + (from + i) * 1000 })]);
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    await feed(h, [...moving(40, 0), ...still(30, 40)]);
    await h.engine.dispatch({ type: 'end', ts: T0 + 70_000, cause: 'walking' });
    expect(h.finalized[0]).toMatchObject({ endCause: 'walking', cut: true });
    expect(h.finalized[0]!.endedAt).toBeLessThanOrEqual(T0 + 41_000);
    const m = harness();
    await m.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    await feed(m, [...moving(40, 0), ...still(30, 40)]);
    await m.engine.dispatch({ type: 'end', ts: T0 + 70_000 });
    expect(m.finalized[0]).toMatchObject({ endCause: 'manual', cut: false, endedAt: T0 + 70_000 });
  });
});

describe('the walking end reads 3 mph (END_CRAWL_MPH)', () => {
  async function walkOff(lastMph: number): Promise<Harness> {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    await feed(h, seq([40, (i) => ({ speed: mph(30), lng: -122.4194 + i * 0.0002, ts: T0 + i * 1000 })]));
    await h.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 45_000 }, ts: T0 + 45_000 });
    await feed(h, seq([25, (i) => ({ speed: mph(lastMph), lng: -122.4194 + 40 * 0.0002, ts: T0 + (41 + i) * 1000 })]));
    return h;
  }

  test('a walk with the car at 2 mph ends the drive', async () => {
    expect((await walkOff(2)).finalized[0]).toMatchObject({ endCause: 'walking' });
  });

  test('at 6 mph the car is still driving: no end', async () => {
    const h = await walkOff(6);
    expect(h.finalized).toEqual([]);
    expect(h.engine.snapshot().status).toBe('recording');
  });
});

test('checkpoints every 30 rows and clears the pending rows; a failed checkpoint keeps them for the next', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
  return createSession({ clientTripId: 'x', startedAt: T0, origin: 'manual' });
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
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues });
    await feed(h, rows);
    await h.engine.dispatch({ type: 'end', ts: T0 + 60_000 });
    return h.finalized[0]!;
  }
  const types = (s: Readonly<TripSession>) => s.events.map((e) => e.type);

  test('a start at 37 mph: the warm-up ends at the first trusted reading, so a phone handled 10 s in is a pickup', async () => {
    const s = await drive(false, [...at(0, 10, { speed: mph(37) }), ...at(10, 3, { speed: mph(37), ...handled }), ...at(13, 5, { speed: mph(37) })]);
    expect(s.warmup).toMatchObject({ decided: true, endsAt: T0 });
    expect(s.events).toEqual([expect.objectContaining({ type: 'phone_pickup', startedAt: T0 + 10_000, durationS: 3 })]);
  });

  test('a stopped start (first reading 0 mph) keeps the 30 s for hard events; speeding and a pickup in them count', async () => {
    const s = await drive(false, [...at(0, 5, { speed: 0 }), ...at(5, 5, { speed: mph(40) }), ...at(10, 3, { speed: mph(40), ...handled }), ...at(13, 5, { speed: mph(40) })]);
    expect(s.warmup).toMatchObject({ decided: true, endsAt: T0 + 30_000 });
    expect(types(s).sort()).toEqual(['phone_pickup', 'speeding']);
    expect(s.events.find((e) => e.type === 'speeding')).toMatchObject({ startedAt: T0 + 5000, durationS: 13 });
  });

  test('a drive that continues the one before (continues) and starts stopped has no warm-up', async () => {
    const s = await drive(true, [...at(0, 2, { speed: 0 }), ...at(2, 3, { speed: mph(35) }), ...at(5, 3, { speed: mph(35), ...handled }), ...at(8, 5, { speed: mph(35) })]);
    expect(s.warmup).toMatchObject({ continues: true, endsAt: T0 });
  });

  test('speeding counts from the first over row, on a moving start and a stopped one alike (no warm-up for speeding)', async () => {
    const moving = await drive(false, [...at(0, 20, { speed: mph(55) }), ...at(20, 10, { speed: mph(30) })]);
    expect(moving.events.filter((e) => e.type === 'speeding').map((e) => [e.startedAt, e.durationS])).toEqual([[T0, 20]]);
    const stopped = await drive(false, [...at(0, 1, { speed: 0 }), ...at(1, 39, { speed: mph(55) }), ...at(40, 10, { speed: mph(30) })]);
    expect(stopped.events.filter((e) => e.type === 'speeding').map((e) => [e.startedAt, e.durationS])).toEqual([[T0 + 1000, 39]]);
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
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
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
    await h.engine.dispatch({ type: 'start', ts: T0 + 9000, origin: 'manual', continues: false });
    expect(h.engine.snapshot().courseDeg).toBeNull();
  });

  test('bearingDeg: from where the car went (the phone pointing anywhere), held when stopped, replayed rows included; null when not recording; reset per drive', async () => {
    const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;
    const north = (s: number, m: number, over: Partial<FeatureRow> = {}) =>
      row({ ts: T0 + s * 1000, lat: 37.7749 + m / M_PER_DEG_LAT, lng: -122.4194, speed: 10, course: -1, ...over });
    const h = harness();
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: null, bearingSource: null });
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: null, bearingSource: null });
    // Replayed rows (a drained journal) build it: positions are facts.
    await h.engine.dispatch({ type: 'row', row: north(0, 0), replay: true });
    await h.engine.dispatch({ type: 'row', row: north(1, 10), replay: true });
    expect(h.engine.snapshot().bearingDeg).toBeNull();
    await h.engine.dispatch({ type: 'row', row: north(2, 20, { orientationDelta: 1.5 }), replay: true });
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: 0, bearingSource: 'track' });
    // A turn east the GPS course reports at speed wins over the lagging track.
    await feed(h, [north(3, 30, { course: 90 })]);
    expect(h.engine.snapshot().bearingDeg).toBe(90);
    // Stopped with jitter and a stale course: held.
    await feed(h, [north(4, 60, { speed: 0, course: 270 }), north(5, 0, { speed: 0 })]);
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: 90, bearingSource: 'track' });
    // The old courseDeg keeps its own rule (the GPS course at 5 mph or more) until the screen switches.
    expect(h.engine.snapshot().courseDeg).toBe(90);
    await h.engine.dispatch({ type: 'end', ts: T0 + 6000 });
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: null, bearingSource: null });
    await h.engine.dispatch({ type: 'start', ts: T0 + 10_000, origin: 'manual', continues: false });
    await feed(h, [north(10, 0)]);
    expect(h.engine.snapshot()).toMatchObject({ bearingDeg: null, bearingSource: null });
  });

  test('speedingRatio: the speed shown over the limit the sign shows, from the first row (no warm-up, no detector gate); over from the speeding line', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
    const ratioNow = () => {
      const s = h.engine.snapshot();
      return { ratio: s.speedingRatio, shown: tintRatio(s.speedMps, s.limitMph) };
    };
    // The first seconds of a start from a standstill: the tint already follows the sign.
    await feed(h, [row({ speed: 0, ts: T0 + 1000 }), row({ speed: mph(42), ts: T0 + 2000 })]);
    expect(ratioNow().ratio).not.toBeNull();
    expect(ratioNow().ratio).toBe(ratioNow().shown);
    expect(ratioNow().ratio!).toBeGreaterThan(1);
    expect(h.engine.snapshot().speedingOver).toBe(true);
    // A steady 35 on a 35: at the limit, not over the line (1.16 L − 0.8 = 39.8).
    await feed(h, after(5, { speed: mph(35) }));
    expect(h.engine.snapshot().speedingRatio).toBeCloseTo(1, 2);
    expect(h.engine.snapshot().speedingOver).toBe(false);
    await feed(h, seq([1, { speed: mph(39.5), ts: T0 + 35_500 }]));
    expect(h.engine.snapshot().speedingOver).toBe(false);
    await feed(h, seq([1, { speed: mph(40.2), ts: T0 + 36_000 }]));
    expect(h.engine.snapshot().speedingOver).toBe(true);
    expect(ratioNow().ratio).toBe(ratioNow().shown);
    // An untrusted speed, or a fix the detector refuses (25 m) but the sign still shows: tinted, never judged.
    await feed(h, seq([3, (i) => ({ speed: mph(45), speedAcc: 3, ts: T0 + 37_000 + i * 1000 })]));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: 35, speedingOver: false });
    expect(h.engine.snapshot().speedingRatio!).toBeGreaterThan(1.1);
    await feed(h, seq([1, { speed: mph(45), hAcc: 25, ts: T0 + 40_000 }]));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: 35, speedingOver: false });
    expect(h.engine.snapshot().speedingRatio!).toBeGreaterThan(1.1);
    await h.engine.dispatch({ type: 'end', ts: T0 + 41_000 });
    expect(h.engine.snapshot()).toMatchObject({ speedingRatio: null, speedingOver: false, lastShake: null });
  });

  test('tintRatio: the shown speed over the shown limit; null with no limit on the sign', () => {
    expect(tintRatio(mph(40), 35)).toBeCloseTo(40 / 35, 9);
    expect(tintRatio(mph(35), 35)).toBeCloseTo(1, 9);
    expect(tintRatio(0, 25)).toBe(0);
    expect(tintRatio(mph(40), null)).toBeNull();
    expect(tintRatio(Number.NaN, 35)).toBeNull();
  });

  test('the sign shows the limit on a fix up to 30 m (display only: past 20 m nothing is judged); past 30 m it holds the last one for 10 s', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
    // The first row is already a poor fix (31 m): nothing to show or hold.
    await feed(h, seq([1, { speed: mph(50), hAcc: 31, ts: T0 + 31_000 }]));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: null, speedingRatio: null });
    // 25 m: shown and tinted, never judged.
    await feed(h, seq([1, { speed: mph(50), hAcc: 25, ts: T0 + 32_000 }]));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: 35, speedingOver: false });
    expect(h.engine.snapshot().speedingRatio!).toBeGreaterThan(1.3);
    await feed(h, seq([1, { speed: mph(50), hAcc: 30, ts: T0 + 33_000 }]));
    expect(h.engine.snapshot().limitMph).toBe(35);
    // 40 m: held for 10 s after the last shown row, then "-".
    await feed(h, seq([1, { speed: mph(50), hAcc: 40, ts: T0 + 43_000 }]));
    expect(h.engine.snapshot().limitMph).toBe(35);
    await feed(h, seq([1, { speed: mph(50), hAcc: 40, ts: T0 + 44_000 }]));
    expect(h.engine.snapshot().limitMph).toBeNull();
  });

  test('a class default is shown on the sign and tints like a posted limit, but is never judged', async () => {
    const h = harness({ limits: { lookup: () => limit(mph(35), 'statutory'), prefetch: () => {} } });
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
    await feed(h, after(2, { speed: mph(50) }));
    expect(h.engine.snapshot()).toMatchObject({ limitMph: 35, speedingOver: false });
    expect(h.engine.snapshot().speedingRatio).toBeCloseTo(50 / 35, 2);
  });
});

describe('the speed-limit prefetch', () => {
  const M_PER_DEG_LAT = (6371008.8 * Math.PI) / 180;
  /** Rows north at 30 m/s from T0 + `from` s: row i is `30·(from + i)` m north of the start. */
  const north = (n: number, from = 0) =>
    seq([n, (i) => ({ speed: 30, course: 0, lat: 37.7749 + (30 * (from + i)) / M_PER_DEG_LAT, ts: T0 + (from + i) * 1000 })]);

  test('once per 1000 m from live rows; replayed rows (where the car was) never ask, and the first live row after them does', async () => {
    const asked: [number, number, number][] = [];
    const h = harness({ limits: { lookup: () => limit(mph(35)), prefetch: (lat, lng, course) => asked.push([lat, lng, course]) } });
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'auto', continues: false });
    // 3 km of a drained journal: no prefetch along the old route.
    for (const r of north(100)) await h.engine.dispatch({ type: 'row', row: r, replay: true });
    expect(asked).toEqual([]);
    // The first live row asks from where the car is now.
    const live = north(40, 100);
    await feed(h, live.slice(0, 1));
    expect(asked).toEqual([[live[0]!.lat, live[0]!.lng, 0]]);
    // Then once per 1000 m of live travel (34 rows at 30 m/s pass it).
    await feed(h, live.slice(1, 34));
    expect(asked).toHaveLength(1);
    await feed(h, live.slice(34, 35));
    expect(asked).toHaveLength(2);
    expect(asked[1]![0]).toBe(live[34]!.lat);
  });
});

describe('speeding alerts and the event shake', () => {
  /** After the warm-up: row i sits at T0 + 31 s + i. */
  // Forward extremes on every row: the axis is learned, so a sharp slowdown is never a GPS-only brake.
  const over = (n: number, speedMph: number, from = 0) =>
    seq([n, (i) => ({ speed: mph(speedMph), aLonMax: 0.02, aLonMin: -0.02, ts: T0 + 31_000 + (from + i) * 1000 })]);
  async function started(): Promise<Harness> {
    const h = harness();
    await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
    return h;
  }
  const rowOf = (at: number) => (at - T0 - 31_000) / 1000;

  test('the first over row alerts at once and shakes the halo once; the chime repeats while over', async () => {
    const h = await started();
    await feed(h, over(20, 47.8));
    const speeding = h.alerts.filter((a) => a.type === 'speeding');
    // 47.8 on a 35 is 8 past the line (39.8): repeats every 8 / 2.6 × 0.85^(elapsed / 10) s (about 3 s here).
    expect(speeding.map((a) => [rowOf(a.at), a.repeat === true])).toEqual([
      [0, false],
      [3, true],
      [6, true],
      [9, true],
      [12, true],
      [15, true],
      [18, true],
    ]);
    // No points ride on any alert.
    for (const a of speeding) expect(Object.keys(a).sort()).toEqual(a.repeat ? ['at', 'id', 'repeat', 'tier', 'type'] : ['at', 'id', 'tier', 'type']);
    // The repeats never touch lastAlert (no banner) and never shake; the first over row is the one shake.
    expect(h.engine.snapshot().lastAlert).toMatchObject({ type: 'speeding', at: T0 + 31_000 });
    expect(h.engine.snapshot().lastShake).toEqual({ key: speeding[0]!.id, at: T0 + 31_000, tier: 'moderate' });
    const keys = new Set(h.snapshots.map((s) => s.lastShake?.key).filter((k) => k !== undefined));
    expect(keys.size).toBe(1);
  });

  test('a short episode, back under the line in 5 s: one alert and one shake, and an event of 5 s', async () => {
    const h = await started();
    await feed(h, [...over(5, 45), ...over(10, 30, 5)]);
    const shown = h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true);
    expect(shown).toHaveLength(1);
    expect(h.engine.snapshot().lastShake).toMatchObject({ key: shown[0]!.id, at: T0 + 31_000 });
    await h.engine.dispatch({ type: 'end', ts: T0 + 50_000 });
    expect(h.finalized[0]!.events.filter((e) => e.type === 'speeding').map((e) => e.durationS)).toEqual([5]);
  });

  test('hovering at the line is one episode: no new alert, repeats only on rows over the line; 5 s under the buffer ends it', async () => {
    const h = await started();
    // 2 over, 10 hovering at 38 (above the line less 2, 37.8), 2 over: one alert; nothing sounds while under.
    await feed(h, [...over(2, 41.8), ...over(10, 38, 2), ...over(2, 41.8, 12)]);
    const shown = () => h.alerts.filter((a) => a.type === 'speeding' && a.repeat !== true);
    expect(shown()).toHaveLength(1);
    const sounded = h.alerts.filter((a) => a.type === 'speeding').map((a) => rowOf(a.at));
    // 41.8 is 2 past the line: 8 / 1.4 s = 5.7 s; the row back over at 12 is due at once.
    expect(sounded).toEqual([0, 12]);
    expect(h.snapshots.at(-1)!.speedingOver).toBe(true);
    // 5 rows under 37.8 end the episode; the next over row is a new alert.
    await feed(h, [...over(5, 30, 14), ...over(1, 41.8, 19)]);
    expect(shown()).toHaveLength(2);
  });

  test('the cadence quickens the further over and the longer it lasts: repeats never under 2 s apart', async () => {
    const h = await started();
    await feed(h, over(60, 70));
    const at = h.alerts.filter((a) => a.type === 'speeding').map((a) => rowOf(a.at));
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // 30.2 past the line: 8 / 7.04 s ≈ 1.1, held at the 2-s floor.
    expect(gaps.length).toBeGreaterThan(20);
    expect(gaps.every((g) => g === 2)).toBe(true);
  });

  test('a replayed row (a journal drained) tells its alerts but never shows or shakes them: a hard brake and speeding alike', async () => {
    const steady = { aLonMax: 0.02, aLonMin: -0.02 };
    const at = (fromS: number, n: number, o: Partial<FeatureRow>) => seq([n, (i) => ({ ...o, ts: T0 + 31_000 + (fromS + i) * 1000 })]);
    // 60 on a 35 for 5 rows (over the line), then a hard brake to 50.
    const list = [...at(0, 5, { speed: mph(60), ...steady }), ...at(5, 1, { speed: mph(50), aLonMax: 0.02, aLonMin: -0.35 }), ...at(6, 4, { speed: mph(50), ...steady })];
    const replayed = await started();
    for (const r of list) await replayed.engine.dispatch({ type: 'row', row: r, replay: true });
    expect(replayed.alerts.map((a) => a.type)).toEqual(expect.arrayContaining(['speeding', 'hard_brake']));
    expect(replayed.snapshots.every((st) => st.lastAlert === null && st.lastShake === null)).toBe(true);
    // The same rows live: shown and shaken.
    const live = await started();
    await feed(live, list);
    expect(live.alerts.map((a) => a.type)).toEqual(replayed.alerts.map((a) => a.type));
    expect(live.engine.snapshot().lastAlert).not.toBeNull();
    expect(live.engine.snapshot().lastShake).not.toBeNull();
    // A live row after replayed ones shows its own alert as ever.
    await replayed.engine.dispatch({ type: 'row', row: at(10, 1, { speed: mph(40), aLonMax: 0.02, aLonMin: -0.5 })[0]! });
    await feed(replayed, at(11, 3, { speed: mph(40), ...steady }));
    expect(replayed.engine.snapshot().lastAlert).toMatchObject({ type: 'hard_brake', at: T0 + 41_000 });
    expect(replayed.engine.snapshot().lastShake).toMatchObject({ at: T0 + 41_000 });
  });

  test('a hard brake shakes with its tier; a speeding episode shakes on its first over row, never again', async () => {
    const h = await started();
    // 60 on a 35 for 5 rows, then a hard brake to 50 on the 6th over row (still over the line, 39).
    const steady = { aLonMax: 0.02, aLonMin: -0.02 };
    const at = (fromS: number, n: number, o: Partial<FeatureRow>) => seq([n, (i) => ({ ...o, ts: T0 + 31_000 + (fromS + i) * 1000 })]);
    await feed(h, [...at(0, 5, { speed: mph(60), ...steady }), ...at(5, 1, { speed: mph(50), aLonMax: 0.02, aLonMin: -0.35 }), ...at(6, 4, { speed: mph(50), ...steady })]);
    const brakeRow = T0 + 31_000 + 5000;
    const first = h.alerts.find((a) => a.type === 'speeding')!;
    expect(first.at).toBe(T0 + 31_000);
    expect(h.snapshots.some((st) => st.lastShake?.key === first.id && st.lastShake.at === T0 + 31_000)).toBe(true);
    // The brake's row carries one shake, the brake's.
    const published = h.snapshots.map((st) => st.lastShake).filter((d) => d !== null && d.at === brakeRow);
    const brakeAlert = h.alerts.find((a) => a.type === 'hard_brake')!;
    expect(new Set(published.map((d) => d!.key))).toEqual(new Set([brakeAlert.id]));
    expect(h.snapshots.filter((st) => st.lastShake?.key === first.id).every((st) => st.lastShake!.at === T0 + 31_000)).toBe(true);

    const b = await started();
    await feed(b, [...at(0, 5, { speed: mph(30), ...steady }), ...at(5, 1, { speed: mph(15), aLonMax: 0.02, aLonMin: -0.5 }), ...at(6, 4, { speed: mph(15), ...steady })]);
    const brake = b.alerts.find((a) => a.type === 'hard_brake')!;
    expect(b.engine.snapshot().lastShake).toEqual({ key: brake.id, at: brake.at, tier: brake.tier });
  });

  test('the opportunity counters follow the rows: a slowdown, a speed-up and the limit seconds', async () => {
    const h = await started();
    const steady = { aLonMax: 0.02, aLonMin: -0.02 };
    await feed(h, [...over(10, 30), ...over(10, 10, 10), ...over(10, 30, 20)].map((r) => ({ ...r, ...steady })));
    const s = h.engine.session()!;
    expect(s.exposure.slowdowns).toBe(1);
    expect(s.exposure.limitS).toBe(30);
  });
});

test('a held drive (a Start-card drive still waiting) ends only at the 12 h cap: no still end, no walking end; `drove` says when it reached driving speed', async () => {
  let held = true;
  const h = harness({ holdEnds: () => held });
  await h.engine.dispatch({ type: 'start', ts: T0, origin: 'manual', continues: false });
  expect(h.engine.snapshot()).toMatchObject({ status: 'recording', drove: false, autoEndAt: T0 + 12 * 3600_000 });
  // Parked 10 min, walking reported: still recording.
  await feed(h, after(600, { speed: 0 }));
  await h.engine.dispatch({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: T0 + 100_000 }, ts: T0 + 100_000 });
  await h.engine.dispatch({ type: 'tick', ts: T0 + 700_000 });
  expect(h.engine.snapshot()).toMatchObject({ status: 'recording', drove: false });
  expect(h.finalized).toEqual([]);
  // Two rows at driving speed: `drove`.
  await feed(h, seq([2, (i) => ({ speed: mph(15), ts: T0 + 632_000 + i * 1000 })]));
  expect(h.engine.snapshot().drove).toBe(true);
  // The hold lifts: the still end applies again.
  held = false;
  expect(h.engine.snapshot().autoEndAt).toBeLessThan(T0 + 12 * 3600_000);
});
