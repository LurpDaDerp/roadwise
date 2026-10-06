import { mph, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import { appendRow, closeSession, createSession, durationSOf, GNSS_JUMP_MPS } from '@/core/engine/session';

const start = () => createSession({ clientTripId: 't1', startedAt: T0, dmsOn: false });

/** Rows heading east at `mps` from a Seattle corner; the position is integrated from the speed. */
function eastward(n: number, mps: number, over: (i: number) => Partial<ReturnType<typeof row>> = () => ({})) {
  const M_PER_DEG_LNG = 111_194.93 * Math.cos((47.6062 * Math.PI) / 180);
  return seq([n, (i) => ({ lat: 47.6062, lng: -122.3321 + (i * mps) / M_PER_DEG_LNG, speed: mps, ...over(i) })]);
}

test('distance integrates consecutive valid fixes; safe and night distance follow their flags', () => {
  const s = start();
  const rows = eastward(11, 10);
  rows.forEach((r, i) => appendRow(s, r, i >= 6, false));
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
  const s = createSession({ clientTripId: 't1', startedAt: T0 + 8 * 3_600_000, dmsOn: false });
  // 22:13 PST: dark.
  const rows = eastward(11, 10).map((r, i) => ({ ...r, ts: T0 + 8 * 3_600_000 + i * 1000 }));
  rows.forEach((r) => appendRow(s, r, false, false));
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

test('moving rows and IMU activity feed the motion-mismatch heuristic; pending rows and the face flag accumulate', () => {
  const s = start();
  const rows = seq([3, { speed: mph(30), aLonMax: 0.05 }], [3, { speed: mph(30), aLonMax: 0, aLonMin: 0 }], [2, { speed: 0 }]);
  rows.forEach((r, i) => appendRow(s, r, false, i === 4));
  expect(s.movingRows).toBe(6);
  expect(s.imuActiveRows).toBe(3);
  expect(s.pending).toHaveLength(8);
  expect(s.dmsFaceSeen).toBe(true);
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
