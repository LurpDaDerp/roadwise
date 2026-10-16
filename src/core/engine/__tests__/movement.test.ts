// The movement rule (product spec v3 "Ending on its own"; session.ts): pace, place, jumps, the
// walking veto, fix-less rows that hold the idle clock, and the mark.
import { mph, row, T0 } from '@/core/detectors/__fixtures__/rows';
import type { TripSession } from '@/core/engine/engine.types';
import {
  appendRow,
  carried,
  createSession,
  FIXLESS_HOLD_MAX_S,
  holdsClock,
  idleSince,
  imuAbsent,
  isPaceRow,
  lastMovedAt,
  PLACE_SETTLE_MS,
} from '@/core/engine/session';
import type { FeatureRow } from '@/core/engine/types';

const LAT = 37.7749;
const LNG = -122.4194;
/** Metres per degree of latitude on the haversine sphere. */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;
/** A row `northM` metres north of the origin at `s` seconds. */
const at = (s: number, northM: number, over: Partial<FeatureRow> = {}): FeatureRow =>
  row({ ts: T0 + s * 1000, lat: LAT + northM / M_PER_DEG, lng: LNG, ...over });

function run(rows: FeatureRow[]): TripSession {
  const s = createSession({ clientTripId: 'x', startedAt: T0 });
  for (const r of rows) appendRow(s, r, false);
  return s;
}

/** A fix-less row on a mounted phone in a moving car: stable, unhandled, a little yaw. */
const carLike = (s: number, over: Partial<FeatureRow> = {}): FeatureRow =>
  row({ ts: T0 + s * 1000, gnssValid: false, speed: -1, gravityStability: 0.9, handlingScore: 0, orientationDelta: 0.02, yawRateMax: 0.1, ...over });

describe('pace', () => {
  test('two consecutive trusted readings over 5 mph are movement, at the second; one is not', () => {
    expect(run([at(0, 0, { speed: mph(12) })]).moved).toBeNull();
    const s = run([at(0, 0, { speed: mph(12) }), at(1, 5, { speed: mph(12) })]);
    expect(s.moved?.rowTs).toBe(T0 + 1000);
    expect(lastMovedAt(s)).toBe(T0 + 2000);
  });

  test('on poor fixes (hAcc over 20 m) two are not enough; three are', () => {
    const poor = { speed: mph(12), hAcc: 25 };
    expect(run([at(0, 0, poor), at(1, 5, poor)]).moved).toBeNull();
    expect(run([at(0, 0, poor), at(1, 5, poor), at(2, 10, poor)]).moved?.rowTs).toBe(T0 + 2000);
    // One poor row in the run is enough to need three.
    expect(run([at(0, 0, { speed: mph(12) }), at(1, 5, poor)]).moved).toBeNull();
  });

  test('an untrusted speed (speedAcc 3), 4.9 mph and exactly 5 mph are never pace; an unreported accuracy is', () => {
    expect(isPaceRow(row({ speed: mph(30), speedAcc: 3 }))).toBe(false);
    expect(isPaceRow(row({ speed: mph(4.9) }))).toBe(false);
    expect(isPaceRow(row({ speed: mph(5) }))).toBe(false);
    expect(isPaceRow(row({ speed: mph(5.1) }))).toBe(true);
    expect(isPaceRow(row({ speed: mph(30), speedAcc: -1 }))).toBe(true);
    expect(isPaceRow(row({ speed: mph(30), gnssValid: false }))).toBe(false);
    expect(run([at(0, 0, { speed: mph(30), speedAcc: 3 }), at(1, 5, { speed: mph(30), speedAcc: 3 })]).moved).toBeNull();
  });

  test('pace, slow, pace is not movement', () => {
    expect(run([at(0, 0, { speed: mph(12) }), at(1, 1, { speed: mph(3) }), at(2, 2, { speed: mph(12) })]).moved).toBeNull();
  });
});

describe('place', () => {
  const still = { speed: 0 };
  test('99 m on two fixes is not movement; 100 m on two consecutive fixes is; one fix past it is not', () => {
    expect(run([at(0, 0, still), at(10, 99, still), at(20, 99, still)]).moved).toBeNull();
    expect(run([at(0, 0, still), at(10, 100.001, still), at(20, 101, still)]).moved?.rowTs).toBe(T0 + 20_000);
    expect(run([at(0, 0, still), at(10, 100.001, still), at(20, 50, still), at(30, 101, still)]).moved).toBeNull();
  });

  test('the threshold grows with the fixes’ accuracy: at hAcc 40 and 40, 159 m is not movement and 160 m is', () => {
    const poor = { speed: 0, hAcc: 40 };
    expect(run([at(0, 0, poor), at(10, 159, poor), at(20, 159.5, poor)]).moved).toBeNull();
    expect(run([at(0, 0, poor), at(10, 160.001, poor), at(20, 160.5, poor)]).moved).not.toBeNull();
  });

  test('a 150 m jump in 1 s re-anchors and no anchor is set for 30 s after it', () => {
    const s = run([at(0, 0, still), at(1, 150, still)]);
    expect(s.motion.anchor).toBeNull();
    expect(s.motion.anchorAfter).toBe(T0 + 1000 + PLACE_SETTLE_MS);
    appendRow(s, at(20, 150, still), false);
    expect(s.motion.anchor).toBeNull();
    appendRow(s, at(31, 150, still), false);
    expect(s.motion.anchor).toMatchObject({ lat: LAT + 150 / M_PER_DEG, lng: LNG });
    expect(s.moved).toBeNull();
  });

  test('multipath jumping out and back never adds up to movement', () => {
    const rows: FeatureRow[] = [];
    for (let i = 0; i < 300; i += 1) rows.push(at(i, i % 20 < 10 ? 0 : 150, { speed: 0, hAcc: 15 }));
    expect(run(rows).moved).toBeNull();
  });

  test('a walk of 170 m at 3.2 mph is not movement; a creep of 120 m with 10 % of rows at 3 mph is', () => {
    const walk: FeatureRow[] = [];
    for (let i = 0; i <= 120; i += 1) walk.push(at(i, i * 1.43, { speed: mph(3.2) }));
    expect(run(walk).moved).toBeNull();
    const creep: FeatureRow[] = [];
    for (let i = 0; i <= 100; i += 1) creep.push(at(i * 6, i * 1.2, { speed: i % 10 === 0 ? mph(3) : 0 }));
    const s = run(creep);
    // 100.8 m at row 84 is past the threshold; row 85 is the second fix past it.
    expect(s.moved?.rowTs).toBe(T0 + 85 * 6000);
  });

  test('fixes with no speed (-1) move by place', () => {
    expect(run([at(0, 0, { speed: -1 }), at(10, 120, { speed: -1 }), at(20, 130, { speed: -1 })]).moved?.rowTs).toBe(T0 + 20_000);
  });

  test('movement resets the anchor (to the movement fix) and the walking counts', () => {
    const s = run([at(0, 0, { speed: mph(3) }), at(10, 50, { speed: mph(3) }), at(20, 60, { speed: mph(12) }), at(21, 70, { speed: mph(12) })]);
    expect(s.moved?.rowTs).toBe(T0 + 21_000);
    expect(s.motion).toMatchObject({ anchor: { lat: LAT + 70 / M_PER_DEG, lng: LNG, hAcc: 5 }, speedRows: 0, walkRows: 0, placePending: false });
  });
});

describe('fix-less rows and the idle clock', () => {
  test('a stable, unhandled phone with IMU activity holds; a still one and a carried one do not; an IMU-absent one does', () => {
    const s = createSession({ clientTripId: 'x', startedAt: T0 });
    expect(holdsClock(s, carLike(5))).toBe(true);
    expect(holdsClock(s, carLike(5, { yawRateMax: 0, gravityStability: 0.99 }))).toBe(false); // still
    expect(holdsClock(s, carLike(5, { handlingScore: 0.6 }))).toBe(false);
    expect(holdsClock(s, carLike(5, { gravityStability: 0.49 }))).toBe(false);
    expect(holdsClock(s, carLike(5, { orientationDelta: 0.36 }))).toBe(false);
    const absent = row({ ts: T0 + 5000, gnssValid: false, speed: -1, gravityStability: 0, orientationDelta: 0, handlingScore: 0 });
    expect(imuAbsent(absent)).toBe(true);
    expect(carried(absent)).toBe(true);
    expect(holdsClock(s, absent)).toBe(true);
    expect(holdsClock(s, row({ ts: T0 + 5000 }))).toBe(false); // a valid fix never holds
  });

  test('no row holds an hour after the last movement (or the start)', () => {
    const s = run([at(0, 0, { speed: mph(30) }), at(1, 13, { speed: mph(30) })]);
    expect(holdsClock(s, carLike(2 + FIXLESS_HOLD_MAX_S - 0.001))).toBe(true);
    expect(holdsClock(s, carLike(2 + FIXLESS_HOLD_MAX_S))).toBe(false);
    const fresh = createSession({ clientTripId: 'y', startedAt: T0 });
    expect(holdsClock(fresh, carLike(FIXLESS_HOLD_MAX_S))).toBe(false);
  });

  test('a holding row moves the clock base, never the mark; movement clears it', () => {
    const s = run([at(0, 0, { speed: mph(30) }), at(1, 13, { speed: mph(30) })]);
    expect(idleSince(s)).toBe(T0 + 2000);
    appendRow(s, carLike(100), false);
    expect(s.motion.heldUntil).toBe(T0 + 101_000);
    expect(s.moved?.rowTs).toBe(T0 + 1000);
    expect(idleSince(s)).toBe(T0 + 101_000);
    appendRow(s, carLike(101, { handlingScore: 0.9 }), false);
    expect(idleSince(s)).toBe(T0 + 101_000);
    appendRow(s, at(200, 2000, { speed: mph(30) }), false);
    appendRow(s, at(201, 2013, { speed: mph(30) }), false);
    expect(s.motion.heldUntil).toBeNull();
    expect(idleSince(s)).toBe(T0 + 202_000);
  });

  test('a drive that never moved idles from its start', () => {
    const s = run([at(0, 0, { speed: 0 }), at(1, 1, { speed: 0 })]);
    expect(s.moved).toBeNull();
    expect(lastMovedAt(s)).toBeNull();
    expect(idleSince(s)).toBe(T0);
  });
});

describe('the mark', () => {
  test('equals the session right after the movement row', () => {
    const s = run([at(0, 0, { speed: mph(30), mock: true }), at(1, 13, { speed: mph(30), aLonMax: 0.1 })]);
    expect(s.moved).toEqual({
      rowTs: T0 + 1000,
      rowsCount: s.rowsCount,
      validGnssRows: s.validGnssRows,
      mockRows: 1,
      movingRows: s.movingRows,
      imuActiveRows: s.imuActiveRows,
      distanceM: s.distanceM,
      safeDistanceM: s.safeDistanceM,
      nightDistanceM: s.nightDistanceM,
      maxSpeedMps: s.maxSpeedMps,
      lastFix: s.lastFix,
      trackLength: 2,
    });
    // Rows after it change the session, not the mark.
    appendRow(s, at(2, 14, { speed: 0 }), false);
    expect(s.moved?.rowsCount).toBe(2);
    expect(s.rowsCount).toBe(3);
  });

  test('appendRow replaces motion and moved with frozen objects and never mutates the old ones', () => {
    const s = run([at(0, 0, { speed: mph(30) })]);
    const motion = s.motion;
    const copy = { ...s };
    appendRow(s, at(1, 13, { speed: mph(30) }), false);
    expect(s.motion).not.toBe(motion);
    expect(motion.paceRun).toBe(1);
    expect(copy.moved).toBeNull();
    expect(copy.motion).toBe(motion);
    expect(Object.isFrozen(s.motion)).toBe(true);
    expect(Object.isFrozen(s.moved)).toBe(true);
    const moved = s.moved;
    appendRow(s, at(2, 26, { speed: mph(30) }), false);
    expect(s.moved).not.toBe(moved);
    expect(moved?.rowTs).toBe(T0 + 1000);
  });
});
