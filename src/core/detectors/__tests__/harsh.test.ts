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

  test('a 0.30 g acceleration with a matching GNSS rise is a minor hard accel; 0.40 g and up severe', () => {
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.3 }, 10, 10, mph(20), mph(30))).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.52 }, 10, 10, mph(20), mph(32))).all).tier).toBe('severe');
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

describe('hard cornering (spec: sideways force, plausibility by GPS course rate × speed)', () => {
  test('0.45 g lateral with the course swinging 45° in a second at 30 mph is a minor hard corner', () => {
    const rows = seq([10, { speed: mph(30) }], [1, { speed: mph(30), course: 135, aLatMax: 0.45 }], [10, { speed: mph(30), course: 135 }]);
    const e = only(drive(createHarshDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'hard_corner', tier: 'minor' });
    expect(e.measured.peakG).toBe(0.45);
  });

  test('the same lateral peak on a straight course, or below 10 mph, is not a corner', () => {
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLatMax: 0.45 }, 10, 10, mph(30))).all).toEqual([]);
    const slow = seq([10, { speed: mph(8) }], [1, { speed: mph(8), course: 180, aLatMin: -0.5 }], [10, { speed: mph(8), course: 180 }]);
    expect(drive(createHarshDetector(counterIds()), slow).all).toEqual([]);
  });

  test('0.60 g with a plausible turn is severe', () => {
    const rows = seq([10, { speed: mph(40) }], [1, { speed: mph(40), course: 150, aLatMin: -0.6 }], [10, { speed: mph(40), course: 150 }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all).tier).toBe('severe');
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
    const rows = seq([10, { speed: mph(30), speedAcc: 3 }], [1, { speed: mph(30), course: 135, aLatMax: 0.45, speedAcc: 3 }], [10, { speed: mph(30), course: 135, speedAcc: 3 }]);
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

  test('a well-rated 20 → 27 mph rise in a second (0.32 g) is a hard accel', () => {
    const rows = seq([10, { speed: mph(20) }], [10, { speed: mph(27) }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
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
