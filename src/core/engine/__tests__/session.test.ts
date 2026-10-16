import { mph, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import { appendRow, closeAtLastMovement, closeSession, createSession, cutEvents, durationSOf, GNSS_JUMP_MPS, noteWarmup } from '@/core/engine/session';
import type { DetectedEvent } from '@/core/engine/types';

const start = () => createSession({ clientTripId: 't1', startedAt: T0 });

/** Rows heading east at `mps` from a Seattle corner; the position is integrated from the speed. */
function eastward(n: number, mps: number, over: (i: number) => Partial<ReturnType<typeof row>> = () => ({})) {
  const M_PER_DEG_LNG = 111_194.93 * Math.cos((47.6062 * Math.PI) / 180);
  return seq([n, (i) => ({ lat: 47.6062, lng: -122.3321 + (i * mps) / M_PER_DEG_LNG, speed: mps, ...over(i) })]);
}

test('distance integrates consecutive valid fixes; safe and night distance follow their flags', () => {
  const s = start();
  const rows = eastward(11, 10);
  rows.forEach((r, i) => appendRow(s, r, i >= 6));
  expect(s.rowsCount).toBe(11);
  expect(s.validGnssRows).toBe(11);
  expect(s.distanceM).toBeCloseTo(100, 0);
  // Rows 6..10 were unsafe: five of the ten segments.
  expect(s.safeDistanceM).toBeCloseTo(50, 0);
  // T0 is 14:13 PST in November: daylight in Seattle, so no night metres.
  expect(s.nightDistanceM).toBe(0);
  expect(s.track).toHaveLength(11);
  expect(s.firstFix).toEqual({ lat: 47.6062, lng: -122.3321, ts: T0 });
  expect(s.lastFix?.ts).toBe(T0 + 10_000);
  expect(s.maxSpeedMps).toBe(10);
});

test('night distance counts metres driven after sunset at the car’s position', () => {
  const s = createSession({ clientTripId: 't1', startedAt: T0 + 8 * 3_600_000 });
  // 22:13 PST: dark.
  const rows = eastward(11, 10).map((r, i) => ({ ...r, ts: T0 + 8 * 3_600_000 + i * 1000 }));
  rows.forEach((r) => appendRow(s, r, false));
  expect(s.nightDistanceM).toBeCloseTo(100, 0);
});

test('a GNSS jump is skipped, an invalid fix adds nothing, a mock row is counted', () => {
  const s = start();
  const rows = eastward(3, 10);
  appendRow(s, rows[0]!, false);
  appendRow(s, { ...rows[1]!, lat: 48.0 }, false); // ~44 km in a second
  appendRow(s, { ...rows[2]!, gnssValid: false, mock: true }, false);
  expect(s.distanceM).toBe(0);
  expect(s.validGnssRows).toBe(2);
  expect(s.mockRows).toBe(1);
  expect(GNSS_JUMP_MPS).toBe(100);
});

test('moving rows and IMU activity feed the motion-mismatch heuristic; pending rows accumulate', () => {
  const s = start();
  const rows = seq([3, { speed: mph(30), aLonMax: 0.05 }], [3, { speed: mph(30), aLonMax: 0, aLonMin: 0 }], [2, { speed: 0 }]);
  rows.forEach((r) => appendRow(s, r, false));
  expect(s.movingRows).toBe(6);
  expect(s.imuActiveRows).toBe(3);
  expect(s.pending).toHaveLength(8);
});

test('closeSession stamps the end (never before the start) and the cause; the open session is untouched', () => {
  const s = start();
  appendRow(s, row({}, 0), false);
  const closed = closeSession(s, T0 - 5000, 'manual');
  expect(closed.endedAt).toBe(T0 + 1000);
  expect(closed.endCause).toBe('manual');
  expect(s.endedAt).toBeNull();
  expect(Object.isFrozen(closed)).toBe(true);
  expect(durationSOf({ startedAt: T0, endedAt: T0 + 90_500 })).toBe(90.5);
});

describe('the warm-up (noteWarmup)', () => {
  const at = (s: number, over: Parameters<typeof row>[0] = {}) => row({ ts: T0 + s * 1000, ...over });

  test('a drive that starts stopped keeps its 30 s; one that is a restart has none', () => {
    const stopped = createSession({ clientTripId: 'a', startedAt: T0 });
    expect(stopped.warmup).toEqual({ continues: false, decided: false, endsAt: T0 + 30_000 });
    noteWarmup(stopped, at(1, { speed: 0 }));
    expect(stopped.warmup).toEqual({ continues: false, decided: true, endsAt: T0 + 30_000 });
    const restart = createSession({ clientTripId: 'b', startedAt: T0, continues: true });
    expect(restart.warmup).toEqual({ continues: true, decided: true, endsAt: T0 });
    noteWarmup(restart, at(1, { speed: 0 }));
    expect(restart.warmup.endsAt).toBe(T0);
  });

  test('the first trusted reading over 5 mph ends it there; at exactly 5 mph it does not', () => {
    const moving = createSession({ clientTripId: 'a', startedAt: T0 });
    noteWarmup(moving, at(2, { speed: mph(40) }));
    expect(moving.warmup).toEqual({ continues: false, decided: true, endsAt: T0 + 2000 });
    noteWarmup(moving, at(3, { speed: 0 }));
    expect(moving.warmup.endsAt).toBe(T0 + 2000);
    const five = createSession({ clientTripId: 'b', startedAt: T0 });
    noteWarmup(five, at(2, { speed: mph(5) }));
    expect(five.warmup).toMatchObject({ decided: true, endsAt: T0 + 30_000 });
    // Decided at a stop: a later reading at speed does not shorten it.
    noteWarmup(five, at(5, { speed: mph(40) }));
    expect(five.warmup.endsAt).toBe(T0 + 30_000);
  });

  test('undecided until a trusted known speed: no fix, an unknown speed or an untrusted one (speedAcc 3) decide nothing', () => {
    const s = createSession({ clientTripId: 'a', startedAt: T0 });
    noteWarmup(s, at(1, { gnssValid: false, speed: -1 }));
    noteWarmup(s, at(2, { speed: -1 }));
    noteWarmup(s, at(3, { speed: mph(40), speedAcc: 3 }));
    expect(s.warmup).toEqual({ continues: false, decided: false, endsAt: T0 + 30_000 });
    noteWarmup(s, at(4, { speed: mph(40), speedAcc: -1 }));
    expect(s.warmup).toEqual({ continues: false, decided: true, endsAt: T0 + 4000 });
  });

  test('a reading at 30 s or later never shortens it; a buffered row from before the tap ends it at the start', () => {
    const late = createSession({ clientTripId: 'a', startedAt: T0 });
    noteWarmup(late, at(31, { speed: mph(40) }));
    expect(late.warmup).toEqual({ continues: false, decided: true, endsAt: T0 + 30_000 });
    const early = createSession({ clientTripId: 'b', startedAt: T0 });
    noteWarmup(early, at(-1, { speed: mph(40) }));
    expect(early.warmup.endsAt).toBe(T0);
  });

  test('the warm-up object is replaced, never mutated (an adopted copy keeps its own)', () => {
    const s = createSession({ clientTripId: 'a', startedAt: T0 });
    const before = s.warmup;
    const copy = { ...s };
    noteWarmup(s, at(2, { speed: mph(40) }));
    expect(s.warmup).not.toBe(before);
    expect(before).toEqual({ continues: false, decided: false, endsAt: T0 + 30_000 });
    expect(copy.warmup).toBe(before);
    expect(Object.isFrozen(s.warmup)).toBe(true);
  });
});

describe('the cut at the last movement', () => {
  const ev = (type: DetectedEvent['type'], startS: number, durationS: number, over: Partial<DetectedEvent> = {}): DetectedEvent => ({
    id: `${type}-${startS}`,
    type,
    tier: 'minor',
    startedAt: T0 + startS * 1000,
    durationS,
    measured: {},
    ...over,
  });
  const CUT = T0 + 100_000;

  test('cutEvents: a non-instant event starting at the cut goes, 1 ms before it stays (clamped); events before it are untouched', () => {
    const before = ev('speeding', 10, 20);
    const out = cutEvents([before, ev('speeding', 100, 5), ev('phone_pickup', 99.999, 10)], CUT);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(before);
    expect(out[1]).toMatchObject({ type: 'phone_pickup', durationS: expect.closeTo(0.001, 6) });
  });

  test('cutEvents: an instant event is kept when it starts before the cut + 2 s (finalize’s slack), its length untouched', () => {
    const out = cutEvents([ev('hard_brake', 100, 1), ev('hard_accel', 101.999, 1), ev('hard_corner', 102, 1)], CUT);
    expect(out.map((e) => e.type)).toEqual(['hard_brake', 'hard_accel']);
    expect(out.map((e) => e.durationS)).toEqual([1, 1]);
  });

  test('cutEvents: crossing events end at the cut; a clipped handling event gets its units and tier again; one after the cut goes, its pickup stays', () => {
    const out = cutEvents(
      [
        ev('speeding', 90, 30, { tier: 'moderate' }),
        ev('phone_pickup', 73, 55, { tier: 'severe', stoppedInTraffic: true }),
        ev('phone_handling', 88, 40, { tier: 'severe', units: 3 }),
        ev('phone_handling', 80, 40, { tier: 'severe', units: 3 }),
        ev('phone_handling', 100, 40, { tier: 'severe', units: 3 }),
      ],
      CUT
    );
    expect(out).toEqual([
      expect.objectContaining({ type: 'speeding', durationS: 10, tier: 'moderate' }),
      expect.objectContaining({ type: 'phone_pickup', durationS: 27, tier: 'severe', stoppedInTraffic: true }),
      expect.objectContaining({ type: 'phone_handling', startedAt: T0 + 88_000, durationS: 12, units: 1, tier: 'moderate' }),
      expect.objectContaining({ type: 'phone_handling', startedAt: T0 + 80_000, durationS: 20, units: 2, tier: 'severe' }),
    ]);
  });

  test('closeAtLastMovement: the accumulators, track and events come back to the mark; the open session is untouched', () => {
    const s = createSession({ clientTripId: 'x', startedAt: T0 });
    const drive = seq([60, (i) => ({ speed: mph(30), lng: -122.4194 + i * 0.00015, ts: T0 + i * 1000 })]);
    const parked = seq([300, (i) => ({ speed: 0.3, lat: 37.7749 + Math.sin(i) * 0.00005, lng: -122.4194 + 59 * 0.00015, ts: T0 + (60 + i) * 1000 })]);
    for (const r of [...drive, ...parked]) appendRow(s, r, false);
    s.events.push(ev('phone_pickup', 200, 10, { tier: 'severe' }), ev('speeding', 30, 10));
    const before = { distanceM: s.distanceM, rows: s.rowsCount, track: s.track.length, events: s.events.length };
    const closed = closeAtLastMovement(s, 'stopped');
    expect(closed).toMatchObject({ endedAt: T0 + 60_000, endCause: 'stopped', cut: true, lastRowTs: T0 + 59_000, rowsCount: 60, validGnssRows: 60 });
    expect(closed.distanceM).toBe(s.moved!.distanceM);
    expect(closed.distanceM).toBeLessThan(before.distanceM);
    expect(closed.track).toHaveLength(60);
    expect(closed.lastFix).toEqual(s.moved!.lastFix);
    expect(closed.events.map((e) => e.type)).toEqual(['speeding']);
    expect(Object.isFrozen(closed)).toBe(true);
    expect({ distanceM: s.distanceM, rows: s.rowsCount, track: s.track.length, events: s.events.length }).toEqual(before);
    expect(s.cut).toBe(false);
  });

  test('closeAtLastMovement on a drive that never moved ends after its last row (never before start + 1 s), uncut', () => {
    const s = createSession({ clientTripId: 'x', startedAt: T0 });
    expect(closeAtLastMovement(s, 'stopped')).toMatchObject({ endedAt: T0 + 1000, cut: false, moved: null });
    for (const r of seq([10, { speed: 0 }])) appendRow(s, r, false);
    expect(closeAtLastMovement(s, 'walking')).toMatchObject({ endedAt: T0 + 10_000, endCause: 'walking', cut: false });
    expect(closeAtLastMovement(s, 'walking', { notAfter: T0 + 5000 })).toMatchObject({ endedAt: T0 + 10_000, cut: false });
  });

  test('closeAtLastMovement with notAfter cuts at the last movement at or before it', () => {
    const s = createSession({ clientTripId: 'x', startedAt: T0 });
    // 60 s at 30 mph (movement on every row from the second), then 60 s parked.
    const drive = seq([60, (i) => ({ speed: mph(30), lng: -122.4194 + i * 0.00015, ts: T0 + i * 1000 })]);
    const parked = seq([60, (i) => ({ speed: 0, lng: -122.4194 + 59 * 0.00015, ts: T0 + (60 + i) * 1000 })]);
    for (const r of [...drive, ...parked]) appendRow(s, r, false);
    // The walk began at +30.5 s: the mark of the row at +30 s.
    const mid = closeAtLastMovement(s, 'walking', { notAfter: T0 + 30_500 });
    expect(mid).toMatchObject({ endedAt: T0 + 31_000, lastRowTs: T0 + 30_000, rowsCount: 31, cut: true, endCause: 'walking' });
    expect(mid.track).toHaveLength(31);
    expect(mid.distanceM).toBeLessThan(s.moved!.distanceM);
    // A walk that began after the last movement: the last movement, as without notAfter.
    expect(closeAtLastMovement(s, 'walking', { notAfter: T0 + 100_000 })).toMatchObject({ endedAt: T0 + 60_000, lastRowTs: T0 + 59_000 });
    // Exactly at a mark's row ts: that mark.
    expect(closeAtLastMovement(s, 'walking', { notAfter: T0 + 20_000 })).toMatchObject({ endedAt: T0 + 21_000 });
    // Before every kept mark: the oldest kept one (the first movement, row 1).
    expect(closeAtLastMovement(s, 'walking', { notAfter: T0 - 5000 })).toMatchObject({ endedAt: T0 + 2000, lastRowTs: T0 + 1000 });
    expect(s.cut).toBe(false);
  });

  test('closeAtLastMovement with notAfter older than every kept mark falls back to the oldest kept (5 min behind the newest)', () => {
    const s = createSession({ clientTripId: 'x', startedAt: T0 });
    const drive = seq([600, (i) => ({ speed: mph(30), lng: -122.4194 + i * 0.00015, ts: T0 + i * 1000 })]);
    for (const r of drive) appendRow(s, r, false);
    expect(s.marks[0]!.rowTs).toBe(T0 + 299_000);
    expect(closeAtLastMovement(s, 'walking', { notAfter: T0 + 100_000 })).toMatchObject({ lastRowTs: T0 + 299_000, endedAt: T0 + 300_000 });
  });
});
