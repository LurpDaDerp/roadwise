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

test('alerts: one chime per speeding episode, the pickup and the 15-s handling alert, instant events as they close', async () => {
  const h = harness();
  await h.engine.dispatch({ type: 'start', ts: T0, continues: false });
  await feed(h, after(10, { speed: mph(47) }));
  await feed(h, seq([10, (i) => ({ speed: mph(30), ts: T0 + 41_000 + i * 1000 })]));
  expect(h.alerts.filter((a) => a.type === 'speeding')).toHaveLength(1);
  expect(h.alerts[0]).toMatchObject({ type: 'speeding', tier: 'moderate' });
  expect(h.snapshots.some((s) => s.speedingTier === 'moderate')).toBe(true);
  const phoneRows = seq([20, (i) => ({ speed: mph(30), handlingScore: 0.9, gravityStability: 0.5, ts: T0 + 51_000 + i * 1000 })]);
  await feed(h, phoneRows);
  await feed(h, seq([3, (i) => ({ speed: mph(30), ts: T0 + 71_000 + i * 1000 })]));
  const phone = h.alerts.filter((a) => a.type.startsWith('phone'));
  expect(phone.map((a) => a.type)).toEqual(['phone_pickup', 'phone_handling']);
  expect(phone[1]!.at - phone[0]!.at).toBeGreaterThanOrEqual(15_000 - 2000);
  // A confirmed brake is told on the row that releases it.
  await feed(h, seq([5, (i) => ({ speed: mph(35), ts: T0 + 74_000 + i * 1000 })]));
  await feed(h, [row({ speed: mph(25), aLonMin: -0.5, ts: T0 + 79_000 }), ...seq([4, (i) => ({ speed: mph(25), ts: T0 + 80_000 + i * 1000 })])]);
  expect(h.alerts.at(-1)).toMatchObject({ type: 'hard_brake', tier: 'minor' });
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

  test('a start at 40 mph: three handling rows at +10 s are a pickup', async () => {
    const s = await drive(false, [...at(0, 10, { speed: mph(40) }), ...at(10, 3, { speed: mph(40), ...handled }), ...at(13, 5, { speed: mph(40) })]);
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
