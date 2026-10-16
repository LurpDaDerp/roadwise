import { mph, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import { appendRow, closeSession, createSession, durationSOf, GNSS_JUMP_MPS, noteWarmup } from '@/core/engine/session';

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
