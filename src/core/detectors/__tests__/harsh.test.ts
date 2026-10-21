import { createHarshDetector } from '@/core/detectors/harsh';
import { counterIds, ctx, drive, mph, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { FeatureRow } from '@/core/engine/types';

/** `n` cruise rows, one IMU peak row with the GNSS change the rows after it show, then a tail. */
function peakDrive(peak: Partial<FeatureRow>, before: number, after: number, speedBefore = mph(35), speedAfter = speedBefore): FeatureRow[] {
  return seq([before, { speed: speedBefore }], [1, { speed: speedAfter, ...peak }], [after, { speed: speedAfter }]);
}

describe('hard braking / acceleration (spec event table, "confirmed by GPS")', () => {
  test('a 0.35 g brake with a matching GNSS drop is one minor hard brake, told on the row after the 2-s hold', () => {
    const rows = peakDrive({ aLonMin: -0.35 }, 10, 10, mph(35), mph(25));
    const { pushed, all } = drive(createHarshDetector(counterIds()), rows);
    const e = only(all);
    expect(e).toMatchObject({ type: 'hard_brake', tier: 'minor', startedAt: T0 + 10_000, durationS: 1 });
    expect(e.measured).toEqual({ peakG: 0.35, speedMph: 25 });
    // Released once the 2-s veto window has passed, never on the peak row itself.
    expect(pushed[10]).toEqual([]);
    expect(pushed.findIndex((p) => p.length > 0)).toBeGreaterThan(11);
  });

  test('0.45 g and up is severe; the GNSS drop may land on the row after the peak', () => {
    const rows = seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6 }], [10, { speed: mph(30) }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all).tier).toBe('severe');
  });

  test('an IMU peak the GNSS speed does not confirm is ignored', () => {
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMin: -0.5 }, 10, 10)).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.5 }, 10, 10)).all).toEqual([]);
  });

  test('a 0.32 g acceleration with a matching GNSS rise is a minor hard accel (0.31 g is none); 0.45 g and up severe', () => {
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.32 }, 10, 10, mph(20), mph(30))).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.31 }, 10, 10, mph(20), mph(30))).all).toEqual([]);
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.44 }, 10, 10, mph(20), mph(32))).all).tier).toBe('minor');
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.45 }, 10, 10, mph(20), mph(32))).all).tier).toBe('severe');
  });

  test('a free-fall or slide spike within two seconds vetoes the event', () => {
    const rows = seq([10, { speed: mph(35) }], [1, { speed: mph(25), aLonMin: -0.5 }], [1, { speed: mph(25), orientationDelta: 0.9 }], [10, { speed: mph(25) }]);
    expect(drive(createHarshDetector(counterIds()), rows).all).toEqual([]);
    const lost = seq([10, { speed: mph(35) }], [1, { speed: mph(25), aLonMin: -0.5, gravityStability: 0.2 }], [10, { speed: mph(25) }]);
    expect(drive(createHarshDetector(counterIds()), lost).all).toEqual([]);
  });

  test('nothing in the first 30 s or on a poor fix', () => {
    const rows = peakDrive({ aLonMin: -0.45 }, 10, 10, mph(35), mph(25));
    expect(drive(createHarshDetector(counterIds()), rows, undefined, ctx({ warmupEndsAt: T0 + 30_000 })).all).toEqual([]);
    const poor = peakDrive({ aLonMin: -0.45, hAcc: 30 }, 10, 10, mph(35), mph(25));
    expect(drive(createHarshDetector(counterIds()), poor).all).toEqual([]);
  });

  test('consecutive peak rows are one episode, not two events', () => {
    const rows = seq([10, { speed: mph(40) }], [2, (i) => ({ speed: mph(40 - (i - 9) * 8), aLonMin: -0.45 })], [10, { speed: mph(20) }]);
    const e = only(drive(createHarshDetector(counterIds()), rows).all);
    expect(e.durationS).toBe(2);
  });
});

describe('hard cornering (spec: sideways force, confirmed by the gyroscope and the GPS course turning the same way)', () => {
  // The lateral force is left-positive and the course clockwise: a right turn (course rising) pushes
  // the phone right (negative). 30 mph is 13.4 m/s: 0.8 rad/s of yaw is 1.09 g of turn.
  /** A turn at `v` mph from course 90 to `to` in one second, the peak row's force and yaw as given. */
  const turn = (to: number, peak: Partial<FeatureRow>, v = 30) =>
    seq([10, { speed: mph(v) }], [1, { speed: mph(v), course: to, yawRateMax: 0.8, ...peak }], [10, { speed: mph(v), course: to }]);
  const corner = (rows: FeatureRow[]) => drive(createHarshDetector(counterIds()), rows).all;

  test('0.45 g to the right with the course swinging 45° right in a second at 30 mph is a minor hard corner; to the left with a left turn too', () => {
    const e = only(corner(turn(135, { aLatMin: -0.45 })));
    expect(e).toMatchObject({ type: 'hard_corner', tier: 'minor' });
    expect(e.measured.peakG).toBe(0.45);
    expect(only(corner(turn(45, { aLatMax: 0.45 }))).type).toBe('hard_corner');
  });

  test('the force against the turn (a jolt to the left in a right turn) is not a corner', () => {
    expect(corner(turn(135, { aLatMax: 0.45 }))).toEqual([]);
    expect(corner(turn(45, { aLatMin: -0.45 }))).toEqual([]);
  });

  test('the same lateral peak on a straight course, or below 10 mph, is not a corner', () => {
    expect(corner(turn(90, { aLatMin: -0.45 }))).toEqual([]);
    expect(corner(turn(180, { aLatMin: -0.5 }, 8))).toEqual([]);
  });

  test('an unknown course (-1) beside the peak confirms nothing: it is no 136° turn', () => {
    const rows = seq([10, { speed: mph(30), course: -1 }], [1, { speed: mph(30), course: 135, yawRateMax: 0.8, aLatMin: -0.45 }], [10, { speed: mph(30), course: -1 }]);
    expect(corner(rows)).toEqual([]);
    const after = seq([10, { speed: mph(30) }], [1, { speed: mph(30), course: -1, yawRateMax: 0.8, aLatMin: -0.45 }], [10, { speed: mph(30), course: -1 }]);
    expect(corner(after)).toEqual([]);
  });

  test('a course jumping faster than 60°/s at 10 mph or more is the fix, not the car', () => {
    expect(corner(turn(150, { aLatMin: -0.45 }))).toHaveLength(1); // 60°/s: a turn
    expect(corner(turn(151, { aLatMin: -0.45 }))).toEqual([]);
    expect(corner(turn(200, { aLatMin: -0.45 }))).toEqual([]);
  });

  test('the GPS must make at least half the peak plausible: 9° in a second at 30 mph (0.21 g) does not confirm 0.45 g, 10° (0.24 g) does', () => {
    expect(corner(turn(99, { aLatMin: -0.45 }))).toEqual([]);
    expect(corner(turn(100, { aLatMin: -0.45 }))).toHaveLength(1);
  });

  test('the gyroscope must turn with it: speed × yaw rate at least half the peak', () => {
    // 0.45 g at 13.4 m/s needs 0.165 rad/s.
    expect(corner(turn(135, { aLatMin: -0.45, yawRateMax: 0.16 }))).toEqual([]);
    expect(corner(turn(135, { aLatMin: -0.45, yawRateMax: 0.17 }))).toHaveLength(1);
    expect(corner(turn(135, { aLatMin: -0.45, yawRateMax: 0 }))).toEqual([]);
  });

  test('a wobble (past 0.25 g both ways in one second) is not a corner', () => {
    expect(corner(turn(135, { aLatMin: -0.45, aLatMax: 0.3 }))).toEqual([]);
    expect(corner(turn(135, { aLatMin: -0.45, aLatMax: 0.24 }))).toHaveLength(1);
  });

  test('0.60 g with a plausible turn is severe', () => {
    const rows = seq([10, { speed: mph(40) }], [1, { speed: mph(40), course: 150, yawRateMax: 1, aLatMin: -0.6 }], [10, { speed: mph(40), course: 150 }]);
    expect(only(corner(rows)).tier).toBe('severe');
  });
});

describe('alerts at confirmation (the event itself still waits out the veto)', () => {
  /** Push every row, keeping what alerts() told after each one. */
  function tell(rows: FeatureRow[]) {
    const det = createHarshDetector(counterIds());
    const told: string[][] = [];
    const released: number[] = [];
    const events = rows.flatMap((r, i) => {
      const out = det.push(r, L35, ctx());
      if (out.length > 0) released.push(i);
      told.push(det.alerts().map((a) => `${a.id}:${a.type}:${a.tier}`));
      return out;
    });
    return { told, released, events: [...events, ...det.flush()] };
  }
  const L35 = { limitMps: mph(35), source: 'posted', matchConfidence: 1, parallelRoads: false } as const;

  test('a brake the GNSS confirms on its peak row is alerted on that row, once; the event is released after the hold', () => {
    const t = tell(peakDrive({ aLonMin: -0.35 }, 10, 10, mph(35), mph(25)));
    expect(t.told.findIndex((x) => x.length > 0)).toBe(10);
    expect(t.told[10]).toEqual(['e1:hard_brake:minor']);
    expect(t.told.flat()).toHaveLength(1);
    expect(t.released).toEqual([13]);
  });

  test('a GNSS drop a row late alerts on that row', () => {
    const t = tell(seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6 }], [10, { speed: mph(30) }]));
    expect(t.told.findIndex((x) => x.length > 0)).toBe(11);
    expect(t.told[11]).toEqual(['e1:hard_brake:severe']);
  });

  test('a multi-row episode alerts once, at its tier so far; the event takes its peak', () => {
    const t = tell(seq([10, { speed: mph(40) }], [1, { speed: mph(35), aLonMin: -0.35 }], [1, { speed: mph(28), aLonMin: -0.5 }], [10, { speed: mph(25) }]));
    expect(t.told.flat()).toEqual(['e1:hard_brake:minor']);
    expect(only(t.events).tier).toBe('severe');
  });

  test('alerted, then vetoed by the phone sliding a moment later: alerted but never an event', () => {
    const t = tell(seq([10, { speed: mph(35) }], [1, { speed: mph(25), aLonMin: -0.5 }], [1, { speed: mph(25), orientationDelta: 0.9 }], [10, { speed: mph(25) }]));
    expect(t.told.findIndex((x) => x.length > 0)).toBe(10);
    expect(t.told.flat()).toHaveLength(1);
    expect(t.events).toEqual([]);
  });

  test('a spike on the peak row, an unconfirmed jolt or a crawl is never alerted', () => {
    expect(tell(seq([10, { speed: mph(35) }], [1, { speed: mph(25), aLonMin: -0.5, gravityStability: 0.2 }], [10, { speed: mph(25) }])).told.flat()).toEqual([]);
    expect(tell(peakDrive({ aLonMin: -0.5 }, 10, 10)).told.flat()).toEqual([]);
    expect(tell(seq([10, { speed: mph(4) }], [1, { speed: mph(1), aLonMin: -0.5 }], [10, { speed: mph(1) }])).told.flat()).toEqual([]);
  });
});

describe('the GPS confirmation reads only trusted speeds (speed accuracy 2 m/s or better, or unrated)', () => {
  const brake = (acc: (i: number) => number) =>
    seq([10, (i) => ({ speed: mph(35), speedAcc: acc(i) })], [1, (i) => ({ speed: mph(25), aLonMin: -0.45, speedAcc: acc(i) })], [10, (i) => ({ speed: mph(25), speedAcc: acc(i) })]);

  test('a confirmed 0.45 g brake is an event at 0.5, at exactly 2 and with no rating (-1)', () => {
    for (const a of [0.5, 2, -1]) expect(only(drive(createHarshDetector(counterIds()), brake(() => a)).all).type).toBe('hard_brake');
  });

  test('the same rows with speedAcc 3 on the two confirming rows are no event', () => {
    expect(drive(createHarshDetector(counterIds()), brake((i) => (i === 9 || i === 10 ? 3 : 0.5))).all).toEqual([]);
    // One untrusted side of the pair is enough to refuse it.
    expect(drive(createHarshDetector(counterIds()), brake((i) => (i === 9 ? 3 : 0.5))).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), brake((i) => (i === 10 ? Number.NaN : 0.5))).all).toEqual([]);
  });

  test('an untrusted peak row confirms nothing: both pairs that could vouch for it include it', () => {
    // The drop lands on the row after the peak (10 → 11), but row 10's speed is untrusted.
    const rows = seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6, speedAcc: 3 }], [10, { speed: mph(30) }]);
    expect(drive(createHarshDetector(counterIds()), rows).all).toEqual([]);
    // A trusted drop two rows on is outside the episode's one-row window.
    const late = seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6, speedAcc: 3 }], [1, { speed: mph(45) }], [10, { speed: mph(30) }]);
    expect(drive(createHarshDetector(counterIds()), late).all).toEqual([]);
    // The same rows all trusted: severe.
    const trusted = seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6 }], [10, { speed: mph(30) }]);
    expect(only(drive(createHarshDetector(counterIds()), trusted).all).tier).toBe('severe');
  });

  test('a corner on untrusted speeds is no event', () => {
    const rows = seq([10, { speed: mph(30), speedAcc: 3 }], [1, { speed: mph(30), course: 135, yawRateMax: 0.8, aLatMin: -0.45, speedAcc: 3 }], [10, { speed: mph(30), course: 135, speedAcc: 3 }]);
    expect(drive(createHarshDetector(counterIds()), rows).all).toEqual([]);
  });
});

describe('before the forward axis is learned, the GPS speed change stands in for the IMU', () => {
  // The fixture rows report no forward extremes (aLonMax = aLonMin = 0) unless told to.
  test('a well-rated 35 → 25 mph drop in a second (0.46 g) is a severe hard brake; 35 → 28 mph (0.32 g) a minor one', () => {
    const severe = seq([10, { speed: mph(35) }], [10, { speed: mph(25) }]);
    expect(only(drive(createHarshDetector(counterIds()), severe).all)).toMatchObject({ type: 'hard_brake', tier: 'severe', startedAt: T0 + 10_000 });
    const minor = seq([10, { speed: mph(35) }], [10, { speed: mph(28) }]);
    expect(only(drive(createHarshDetector(counterIds()), minor).all)).toMatchObject({ type: 'hard_brake', tier: 'minor' });
  });

  test('a well-rated 20 → 28 mph rise in a second (0.36 g) is a hard accel; 20 → 27 mph (0.319 g) is under 0.32 g', () => {
    const rows = seq([10, { speed: mph(20) }], [10, { speed: mph(28) }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(20) }], [10, { speed: mph(27) }])).all).toEqual([]);
  });

  test('a gentle change, a speed rated worse than 1 m/s or unrated, or a jump past 1 g is nothing', () => {
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(35) }], [10, { speed: mph(31) }])).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(35), speedAcc: 1.5 }], [10, { speed: mph(25), speedAcc: 1.5 }])).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(35), speedAcc: -1 }], [10, { speed: mph(25), speedAcc: -1 }])).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(10) }], [10, { speed: mph(40) }])).all).toEqual([]);
  });

  test('once a row has had forward extremes, only the IMU counts', () => {
    const rows = seq([5, { speed: mph(35) }], [1, { speed: mph(35), aLonMax: 0.02, aLonMin: -0.02 }], [5, { speed: mph(35) }], [10, { speed: mph(25) }]);
    expect(drive(createHarshDetector(counterIds()), rows).all).toEqual([]);
  });
});
