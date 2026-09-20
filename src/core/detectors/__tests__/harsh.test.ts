import { CONSTANTS } from '@scoring';
import { createHarshDetector } from '@/core/detectors/harsh';
import { T0, counterIds, ctx, drive, limit, mph, only, row, seq } from '../__fixtures__/rows';

const G = 9.80665;
const SLOWER = 15 - 0.25 * G; // one second later, 0.25 g slower than the 15 m/s default
const FASTER = 15 + 0.25 * G;
const L = limit(mph(35));
const make = () => createHarshDetector(counterIds());

describe('hard braking', () => {
  test('IMU decel with agreeing GNSS Δspeed → source both, q 0.95 on a stable mount', () => {
    const list = seq([1, {}], [1, { aLonMin: -0.35, speed: SLOWER }], [3, { speed: SLOWER }]);
    const e = only(drive(make(), list).all);
    expect(e).toMatchObject({
      id: 'e1',
      category: 'braking',
      startedAt: T0 + 1000,
      durationS: 1,
      q: 0.95,
      corrected: false,
      status: 'scored',
      alertable: true,
      source: 'both',
      measured: { peakG: 0.35, speedMps: SLOWER },
      context: { night: false, precipitation: false },
    });
  });

  test('the +0.1 mount bonus needs mounted mode and gravityStability ≥ 0.9', () => {
    const brake = (extra = {}) =>
      seq([1, {}], [1, { aLonMin: -0.35, speed: SLOWER, ...extra }], [3, { speed: SLOWER }]);
    expect(only(drive(make(), brake(), L, ctx({ mode: 'pocket' })).all)).toMatchObject({
      q: 0.85,
      source: 'both',
    });
    expect(only(drive(make(), brake(), L, ctx({ mode: 'auto' })).all)).toMatchObject({ q: 0.85 });
    expect(only(drive(make(), brake({ gravityStability: 0.89 })).all)).toMatchObject({ q: 0.85 });
    expect(only(drive(make(), brake({ gravityStability: 0.9 })).all)).toMatchObject({ q: 0.95 });
  });

  test('GNSS that does not show the deceleration → q 0.4, possible, source imu', () => {
    const e = only(drive(make(), seq([1, {}], [1, { aLonMin: -0.35 }], [3, {}])).all);
    expect(e).toMatchObject({
      q: 0.4,
      status: 'possible',
      alertable: false,
      source: 'imu',
      measured: { peakG: 0.35 },
    });
  });

  test('a GNSS decel below 0.2 g is a disagreement', () => {
    const list = seq([1, {}], [1, { aLonMin: -0.35, speed: 15 - 0.15 * G }], [3, {}]);
    expect(only(drive(make(), list).all)).toMatchObject({ q: 0.4, source: 'imu' });
  });

  test('a missing or invalid fix on either row is a disagreement, never an agreement', () => {
    const noPrev = seq([1, { aLonMin: -0.35, speed: SLOWER }], [3, { speed: SLOWER }]);
    expect(only(drive(make(), noPrev).all)).toMatchObject({ q: 0.4, source: 'imu' });
    const prevInvalid = seq(
      [1, { gnssValid: false }],
      [1, { aLonMin: -0.35, speed: SLOWER }],
      [3, { speed: SLOWER }]
    );
    expect(only(drive(make(), prevInvalid).all)).toMatchObject({ q: 0.4, source: 'imu' });
    const rowInvalid = seq(
      [1, {}],
      [1, { aLonMin: -0.35, speed: SLOWER, gnssValid: false }],
      [3, { speed: SLOWER }]
    );
    expect(only(drive(make(), rowInvalid).all)).toMatchObject({
      q: 0.4,
      source: 'imu',
      measured: { peakG: 0.35 },
    });
  });

  test('fixes more than 1.5 s apart cannot vouch for the same second', () => {
    const det = make();
    det.push(row({}, 0), L, ctx());
    det.push(row({ aLonMin: -0.35, speed: SLOWER, ts: T0 + 3000 }), L, ctx());
    expect(only(det.flush())).toMatchObject({ q: 0.4, source: 'imu' });
  });

  test('a brake sustained over three rows is one event with the peak g and a 3 s duration', () => {
    const peaks = [0.32, 0.45, 0.31];
    const list = seq(
      [1, {}],
      [3, (i: number) => ({ aLonMin: -peaks[i - 1]!, speed: 15 - 0.25 * G * i })],
      [3, { speed: 15 - 0.75 * G }]
    );
    const e = only(drive(make(), list).all);
    expect(e).toMatchObject({
      category: 'braking',
      startedAt: T0 + 1000,
      durationS: 3,
      q: 0.95,
      source: 'both',
    });
    expect(e.measured.peakG).toBeCloseTo(0.45, 12);
    expect(e.measured.speedMps).toBeCloseTo(15 - 0.5 * G, 12);
  });

  test('threshold edge: −0.30 g counts, −0.29 g does not', () => {
    const at = (g: number) => seq([1, {}], [1, { aLonMin: -g, speed: SLOWER }], [3, {}]);
    expect(drive(make(), at(CONSTANTS.HARSH_BRAKE_G)).all).toHaveLength(1);
    expect(drive(make(), at(0.29)).all).toEqual([]);
  });
});

describe('orientation gate', () => {
  // The braking row is index 2 (row 1 is the agreeing previous fix).
  const withSpike = (at: number, delta = 0.5) =>
    seq([2, {}], [1, { aLonMin: -0.35, speed: SLOWER }], [4, { speed: SLOWER }]).map((r, i) =>
      i === at ? { ...r, orientationDelta: delta } : r
    );

  test.each([
    ['two seconds before', 0],
    ['on the braking row', 2],
    ['two seconds after', 4],
  ])('an orientation spike %s → q 0.3', (_name, at) => {
    expect(only(drive(make(), withSpike(at)).all)).toMatchObject({
      q: 0.3,
      status: 'possible',
      alertable: false,
    });
  });

  test('a spike three seconds after the event is outside the window', () => {
    expect(only(drive(make(), withSpike(5)).all)).toMatchObject({ q: 0.95 });
  });

  test('a spike three seconds before the event is outside the window', () => {
    const list = seq([3, {}], [1, { aLonMin: -0.35, speed: SLOWER }], [3, { speed: SLOWER }]).map(
      (r, i) => (i === 0 ? { ...r, orientationDelta: 0.5 } : r)
    );
    expect(only(drive(make(), list).all)).toMatchObject({ q: 0.95 });
  });

  test('orientationDelta exactly 0.35 rad is not a spike', () => {
    expect(only(drive(make(), withSpike(2, 0.35)).all)).toMatchObject({ q: 0.95 });
  });
});

describe('release timing', () => {
  test('a harsh event is released once the two seconds after it have been seen', () => {
    const det = make();
    expect(det.push(row({}, 0), L, ctx())).toEqual([]);
    expect(det.push(row({ aLonMin: -0.35, speed: SLOWER }, 1), L, ctx())).toEqual([]);
    expect(det.push(row({ speed: SLOWER }, 2), L, ctx())).toEqual([]);
    expect(det.push(row({ speed: SLOWER }, 3), L, ctx())).toHaveLength(1);
    expect(det.flush()).toEqual([]);
  });

  test('flush releases a pending event with what has been seen', () => {
    const det = make();
    det.push(row({}, 0), L, ctx());
    det.push(row({ aLonMin: -0.35, speed: SLOWER }, 1), L, ctx());
    expect(only(det.flush())).toMatchObject({ category: 'braking', q: 0.95 });
    expect(det.flush()).toEqual([]);
  });
});

describe('rapid acceleration', () => {
  test('IMU accel with agreeing GNSS Δspeed → accel event, source both', () => {
    const list = seq([1, {}], [1, { aLonMax: 0.3, speed: FASTER }], [3, { speed: FASTER }]);
    expect(only(drive(make(), list).all)).toMatchObject({
      category: 'accel',
      q: 0.95,
      source: 'both',
      durationS: 1,
      measured: { peakG: 0.3, speedMps: FASTER },
    });
  });

  test('acceleration the GNSS does not confirm → 0.4', () => {
    expect(only(drive(make(), seq([1, {}], [1, { aLonMax: 0.3 }], [3, {}])).all)).toMatchObject({
      category: 'accel',
      q: 0.4,
      source: 'imu',
    });
  });

  test('threshold edge: 0.28 g counts, 0.27 g does not', () => {
    const at = (g: number) => seq([1, {}], [1, { aLonMax: g, speed: FASTER }], [3, {}]);
    expect(drive(make(), at(CONSTANTS.HARSH_ACCEL_G)).all).toHaveLength(1);
    expect(drive(make(), at(0.27)).all).toEqual([]);
  });
});

describe('sharp cornering', () => {
  test.each([
    [16, 1],
    [15, 1],
    [14, 0],
  ])('lateral 0.40 g at %p mph → %p event(s)', (v, count) => {
    const list = seq(
      [1, { speed: mph(v) }],
      [1, { aLatMax: 0.4, speed: mph(v) }],
      [3, { speed: mph(v) }]
    );
    const { all } = drive(make(), list);
    expect(all).toHaveLength(count);
    if (count) {
      expect(all[0]).toMatchObject({
        category: 'cornering',
        q: 0.95,
        source: 'imu',
        durationS: 1,
        measured: { lateralG: 0.4, speedMps: mph(v) },
      });
    }
  });

  test('either lateral sign counts', () => {
    expect(only(drive(make(), seq([1, {}], [1, { aLatMin: -0.4 }], [3, {}])).all)).toMatchObject({
      category: 'cornering',
      measured: { lateralG: 0.4 },
    });
  });

  test('threshold edge: 0.35 g counts, 0.34 g does not', () => {
    const at = (g: number) => seq([1, {}], [1, { aLatMax: g }], [3, {}]);
    expect(drive(make(), at(CONSTANTS.HARSH_CORNER_G)).all).toHaveLength(1);
    expect(drive(make(), at(0.34)).all).toEqual([]);
  });

  test('cornering gets the orientation gate too', () => {
    const list = seq([1, {}], [1, { aLatMax: 0.4, orientationDelta: 0.5 }], [3, {}]);
    expect(only(drive(make(), list).all)).toMatchObject({ category: 'cornering', q: 0.3 });
  });
});

describe('unknown speed', () => {
  // With no usable fix the lockout and the cornering speed gate cannot be checked, so the IMU
  // evidence is logged as possible (q 0.4) rather than scored or dropped, whatever the kind.
  const NO_FIX = { gnssValid: false };

  test('braking with no usable fix is logged as possible', () => {
    const e = only(drive(make(), seq([1, {}], [1, { ...NO_FIX, aLonMin: -0.35 }], [3, {}])).all);
    expect(e).toMatchObject({
      category: 'braking',
      status: 'possible',
      q: 0.4,
      source: 'imu',
      alertable: false,
      measured: { peakG: 0.35 },
    });
    expect(e.measured.speedMps).toBeUndefined();
  });

  test('acceleration with the -1 speed sentinel is logged as possible', () => {
    const e = only(drive(make(), seq([1, {}], [1, { speed: -1, aLonMax: 0.3 }], [3, {}])).all);
    expect(e).toMatchObject({
      category: 'accel',
      status: 'possible',
      q: 0.4,
      source: 'imu',
      measured: { peakG: 0.3 },
    });
    expect(e.measured.speedMps).toBeUndefined();
  });

  test('cornering with no usable fix cannot confirm its speed gate: possible, not dropped', () => {
    const e = only(drive(make(), seq([1, {}], [1, { ...NO_FIX, aLatMax: 0.4 }], [3, {}])).all);
    expect(e).toMatchObject({
      category: 'cornering',
      status: 'possible',
      q: 0.4,
      source: 'imu',
      alertable: false,
      measured: { lateralG: 0.4 },
    });
    expect(e.measured.speedMps).toBeUndefined();
    expect(drive(make(), seq([1, {}], [1, { ...NO_FIX, aLatMax: 0.3 }], [3, {}])).all).toEqual([]);
  });
});

describe('lockout and independence', () => {
  test('nothing is scored below LOCKOUT_SPEED_MPS', () => {
    const list = seq(
      [1, { speed: 1 }],
      [1, { speed: 1, aLonMin: -0.5, aLonMax: 0.5, aLatMax: 0.5 }],
      [3, { speed: 1 }]
    );
    expect(drive(make(), list).all).toEqual([]);
  });

  test('at exactly LOCKOUT_SPEED_MPS a brake is still assessed', () => {
    const lock = CONSTANTS.LOCKOUT_SPEED_MPS;
    const list = seq(
      [1, { speed: lock + 0.25 * G }],
      [1, { speed: lock, aLonMin: -0.35 }],
      [3, { speed: lock }]
    );
    expect(only(drive(make(), list).all)).toMatchObject({
      category: 'braking',
      q: 0.95,
      source: 'both',
    });
  });

  test('braking and cornering on the same row are two events', () => {
    const list = seq(
      [1, {}],
      [1, { aLonMin: -0.35, aLatMax: 0.4, speed: SLOWER }],
      [3, { speed: SLOWER }]
    );
    const { all } = drive(make(), list);
    expect(all.map((e) => [e.id, e.category])).toEqual([
      ['e1', 'braking'],
      ['e2', 'cornering'],
    ]);
  });

  test('a brake followed by an acceleration are two events in time order', () => {
    const list = seq(
      [1, {}],
      [1, { aLonMin: -0.35, speed: SLOWER }],
      [1, { speed: SLOWER }],
      [1, { aLonMax: 0.3, speed: SLOWER + 0.25 * G }],
      [3, { speed: SLOWER + 0.25 * G }]
    );
    const { all } = drive(make(), list);
    expect(all.map((e) => [e.category, e.startedAt])).toEqual([
      ['braking', T0 + 1000],
      ['accel', T0 + 3000],
    ]);
  });
});
