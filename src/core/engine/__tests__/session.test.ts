import { NO_LIMIT, T0, limit, mph, row, seq } from '@/core/detectors/__fixtures__/rows';
import { ROW_MS } from '@/core/detectors/common';
import {
  GNSS_JUMP_MPS,
  RING_S,
  SUSTAINED_WINDOW_S,
  appendRow,
  closeSession,
  createSession,
  noteGap,
  snapshotSession,
} from '@/core/engine/session';
import { haversineMeters } from '@/lib/geo';

const L35 = limit(mph(35));
/** ~100 m of latitude. */
const LAT_100M = 100 / 111_194.93;

const make = () =>
  createSession({
    clientTripId: 'trip-1',
    mode: 'mounted',
    role: 'driver',
    startSource: 'manual',
    startedAt: T0,
  });

describe('createSession', () => {
  test('starts empty, open, with the start facts it was given', () => {
    const s = make();
    expect(s).toMatchObject({
      clientTripId: 'trip-1',
      mode: 'mounted',
      role: 'driver',
      startSource: 'manual',
      startedAt: T0,
      startApproximate: false,
      endedAt: null,
      lastRowTs: null,
      rowsCount: 0,
      validGnssRows: 0,
      limitKnownRows: 0,
      rows: [],
      events: [],
      alerts: [],
      distanceM: 0,
      validGnssPct: 0,
      maxSustainedSpeedMps: 0,
      durationS: 0,
      gaps: [],
      checkpoints: [],
      firstFix: null,
      lastFix: null,
    });
  });

  test('records an approximate start when told so', () => {
    const s = createSession({
      clientTripId: 't',
      mode: 'auto',
      role: 'driver',
      startSource: 'auto',
      startedAt: T0 - 60_000,
      startApproximate: true,
    });
    expect(s.startApproximate).toBe(true);
    expect(s.startedAt).toBe(T0 - 60_000);
  });
});

describe('appendRow counters', () => {
  test('counts rows, valid fixes and known limits; tracks the last row', () => {
    const s = make();
    appendRow(s, row({}, 0), L35);
    appendRow(s, row({ gnssValid: false }, 1), NO_LIMIT);
    appendRow(s, row({}, 2), limit(null, 'posted'));
    appendRow(s, row({}, 3), limit(mph(25), 'cached'));
    expect(s.rowsCount).toBe(4);
    expect(s.validGnssRows).toBe(3);
    expect(s.validGnssPct).toBe(75);
    expect(s.limitKnownRows).toBe(2);
    expect(s.lastRowTs).toBe(T0 + 3000);
  });

  test('durationS covers the last row in full', () => {
    const s = make();
    seq([5, {}]).forEach((r) => appendRow(s, r, L35));
    expect(s.durationS).toBe(5);
    expect(s.lastRowTs).toBe(T0 + 4 * ROW_MS);
  });
});

describe('the ring', () => {
  test('keeps only the last RING_S seconds of rows, oldest first', () => {
    const s = make();
    const rows = seq([RING_S + 10, {}]);
    rows.forEach((r) => appendRow(s, r, L35));
    expect(s.rowsCount).toBe(RING_S + 10);
    expect(s.rows).toHaveLength(RING_S);
    expect(s.rows[0]!.ts).toBe(rows[10]!.ts);
    expect(s.rows[s.rows.length - 1]!.ts).toBe(rows[rows.length - 1]!.ts);
  });

  test('a ring shorter than RING_S holds every row', () => {
    const s = make();
    seq([RING_S, {}]).forEach((r) => appendRow(s, r, L35));
    expect(s.rows).toHaveLength(RING_S);
  });
});

describe('distance', () => {
  test('haversine over consecutive valid fixes', () => {
    const s = make();
    const list = seq([3, (i) => ({ lat: 37.7749 + i * LAT_100M })]);
    list.forEach((r) => appendRow(s, r, L35));
    const expected =
      haversineMeters(list[0]!, list[1]!) + haversineMeters(list[1]!, list[2]!);
    expect(s.distanceM).toBeCloseTo(expected, 6);
    expect(s.distanceM).toBeGreaterThan(199);
    expect(s.distanceM).toBeLessThan(201);
  });

  test('records the first and last valid fix', () => {
    const s = make();
    seq([2, (i) => ({ lat: 37.7749 + i * LAT_100M })], [1, { gnssValid: false, lat: 0, lng: 0 }]).forEach(
      (r) => appendRow(s, r, L35)
    );
    expect(s.firstFix).toEqual({ lat: 37.7749, lng: -122.4194, ts: T0 });
    expect(s.lastFix).toEqual({ lat: 37.7749 + LAT_100M, lng: -122.4194, ts: T0 + 1000 });
  });

  test('invalid fixes add nothing and do not break the chain', () => {
    const s = make();
    seq(
      [1, {}],
      [1, { gnssValid: false, lat: 40, lng: -100 }],
      [1, { lat: 37.7749 + LAT_100M }]
    ).forEach((r) => appendRow(s, r, L35));
    expect(s.distanceM).toBeGreaterThan(99);
    expect(s.distanceM).toBeLessThan(101);
  });

  test('a jump over GNSS_JUMP_MPS between 1 Hz rows is noise and is skipped', () => {
    const s = make();
    const jump = (GNSS_JUMP_MPS + 50) / 111_194.93;
    seq([1, {}], [1, { lat: 37.7749 + jump }], [1, { lat: 37.7749 + jump + LAT_100M }]).forEach(
      (r) => appendRow(s, r, L35)
    );
    // Only the last, sane segment counts.
    expect(s.distanceM).toBeGreaterThan(99);
    expect(s.distanceM).toBeLessThan(101);
  });

  test('the jump allowance scales with the time between the fixes', () => {
    const s = make();
    const far = 1500 / 111_194.93; // 1.5 km in 10 s is 150 m/s: plausible after a gap
    appendRow(s, row({}, 0), L35);
    appendRow(s, row({ lat: 37.7749 + far }, 10), L35);
    expect(s.distanceM).toBeGreaterThan(1499);
    expect(s.distanceM).toBeLessThan(1501);
  });
});

describe('maxSustainedSpeedMps', () => {
  test('is the highest mean over a full SUSTAINED_WINDOW_S window', () => {
    const s = make();
    seq([SUSTAINED_WINDOW_S - 1, { speed: 30 }]).forEach((r) => appendRow(s, r, L35));
    expect(s.maxSustainedSpeedMps).toBe(0);
    appendRow(s, row({ speed: 30 }, SUSTAINED_WINDOW_S - 1), L35);
    expect(s.maxSustainedSpeedMps).toBe(30);
  });

  test('a one-second spike is diluted by the window', () => {
    const s = make();
    seq([SUSTAINED_WINDOW_S - 1, { speed: 10 }], [1, { speed: 100 }]).forEach((r) =>
      appendRow(s, r, L35)
    );
    expect(s.maxSustainedSpeedMps).toBeCloseTo(19, 9);
  });

  test('an unknown or invalid speed restarts the window', () => {
    const s = make();
    seq([SUSTAINED_WINDOW_S - 1, { speed: 30 }], [1, { speed: -1 }], [SUSTAINED_WINDOW_S - 1, { speed: 30 }]).forEach(
      (r) => appendRow(s, r, L35)
    );
    expect(s.maxSustainedSpeedMps).toBe(0);
    const t = make();
    seq([SUSTAINED_WINDOW_S - 1, { speed: 30 }], [1, { speed: 30, gnssValid: false }]).forEach((r) =>
      appendRow(t, r, L35)
    );
    expect(t.maxSustainedSpeedMps).toBe(0);
  });

  test('never falls once reached', () => {
    const s = make();
    seq([SUSTAINED_WINDOW_S, { speed: 30 }], [SUSTAINED_WINDOW_S, { speed: 5 }]).forEach((r) =>
      appendRow(s, r, L35)
    );
    expect(s.maxSustainedSpeedMps).toBe(30);
  });
});

describe('gaps and closing', () => {
  test('noteGap records the gap and durationS excludes it', () => {
    const s = make();
    seq([10, {}]).forEach((r) => appendRow(s, r, L35));
    noteGap(s, s.lastRowTs!, s.lastRowTs! + 300_000);
    appendRow(s, row({}, 310), L35);
    expect(s.gaps).toEqual([{ fromTs: T0 + 9000, toTs: T0 + 309_000 }]);
    // 311 s of wall time, 300 s of gap.
    expect(s.durationS).toBe(11);
  });

  test('a gap is clipped to the close: what lies after endedAt is not subtracted', () => {
    const s = make();
    seq([10, {}]).forEach((r) => appendRow(s, r, L35));
    const t = s.lastRowTs as number;
    // A resume with no row before the close: the gap starts where driving stopped and runs on
    // for ten minutes, but the trip ends at that same instant.
    noteGap(s, t + 1000, t + 600_000);
    expect(closeSession(s, t + 1000).durationS).toBe(s.durationS);
    expect(closeSession(s, t + 1000).durationS).toBe(10);
    // Closing inside the gap counts only the part before the close.
    expect(closeSession(s, t + 6000).durationS).toBe(10);
    // A row after the gap sees it in full, as before.
    appendRow(s, row({}, 610), L35);
    expect(s.durationS).toBe(12);
  });

  test('closeSession returns a frozen copy with endedAt set and the original untouched', () => {
    const s = make();
    seq([3, {}]).forEach((r) => appendRow(s, r, L35));
    const closed = closeSession(s, T0 + 3000);
    expect(closed.endedAt).toBe(T0 + 3000);
    expect(closed.durationS).toBe(3);
    expect(Object.isFrozen(closed)).toBe(true);
    expect(Object.isFrozen(closed.rows)).toBe(true);
    expect(Object.isFrozen(closed.events)).toBe(true);
    expect(s.endedAt).toBeNull();
  });

  test('snapshotSession copies the arrays so later appends do not leak in', () => {
    const s = make();
    appendRow(s, row({}, 0), L35);
    const snap = snapshotSession(s);
    appendRow(s, row({}, 1), L35);
    expect(snap.rows).toHaveLength(1);
    expect(snap.rowsCount).toBe(1);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(s.rows).toHaveLength(2);
  });
});
