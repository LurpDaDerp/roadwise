import { createHarshDetector } from '@/core/detectors/harsh';
import { counterIds, ctx, drive, limit, mph, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { FeatureRow } from '@/core/engine/types';

/** `n` cruise rows, one IMU peak row with the GNSS change the rows after it show, then a tail. */
function peakDrive(peak: Partial<FeatureRow>, before: number, after: number, speedBefore = mph(35), speedAfter = speedBefore): FeatureRow[] {
  return seq([before, { speed: speedBefore }], [1, { speed: speedAfter, ...peak }], [after, { speed: speedAfter }]);
}

describe('hard braking / acceleration (spec event table, "confirmed by GPS")', () => {
  test('a 0.40 g brake with a matching GNSS drop is one minor hard brake, told on the row after the 2-s hold', () => {
    const rows = peakDrive({ aLonMin: -0.4 }, 10, 10, mph(35), mph(25));
    const { pushed, all } = drive(createHarshDetector(counterIds()), rows);
    const e = only(all);
    expect(e).toMatchObject({ type: 'hard_brake', tier: 'minor', startedAt: T0 + 10_000, durationS: 1 });
    expect(e.measured).toEqual({ peakG: 0.4, speedMph: 25 });
    // Released once the 2-s veto window has passed, never on the peak row itself.
    expect(pushed[10]).toEqual([]);
    expect(pushed.findIndex((p) => p.length > 0)).toBeGreaterThan(11);
  });

  test('0.55 g and up is severe; the GNSS drop may land on the row after the peak', () => {
    const rows = seq([10, { speed: mph(45) }], [1, { speed: mph(45), aLonMin: -0.6 }], [10, { speed: mph(30) }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all).tier).toBe('severe');
  });

  test('an IMU peak the GNSS speed does not confirm is ignored', () => {
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMin: -0.5 }, 10, 10)).all).toEqual([]);
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.5 }, 10, 10)).all).toEqual([]);
  });

  test('a 0.40 g acceleration with a matching GNSS rise is a minor hard accel (0.39 g is none); 0.60 g and up severe', () => {
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.4 }, 10, 10, mph(20), mph(30))).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
    expect(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.39 }, 10, 10, mph(20), mph(30))).all).toEqual([]);
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.59 }, 10, 10, mph(20), mph(32))).all).tier).toBe('minor');
    expect(only(drive(createHarshDetector(counterIds()), peakDrive({ aLonMax: 0.6 }, 10, 10, mph(20), mph(32))).all).tier).toBe('severe');
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

  test('0.60 g to the right with the course swinging 45° right in a second at 30 mph is a minor hard corner; to the left with a left turn too', () => {
    const e = only(corner(turn(135, { aLatMin: -0.6 })));
    expect(e).toMatchObject({ type: 'hard_corner', tier: 'minor' });
    expect(e.measured.peakG).toBe(0.6);
    expect(only(corner(turn(45, { aLatMax: 0.6 }))).type).toBe('hard_corner');
  });

  test('a sharp turn counts from 0.48 g sideways (0.47 g is none)', () => {
    expect(only(corner(turn(135, { aLatMin: -0.48 })))).toMatchObject({ type: 'hard_corner', tier: 'minor' });
    expect(corner(turn(135, { aLatMin: -0.47 }))).toEqual([]);
  });

  test('the force against the turn (a jolt to the left in a right turn) is not a corner', () => {
    expect(corner(turn(135, { aLatMax: 0.6 }))).toEqual([]);
    expect(corner(turn(45, { aLatMin: -0.6 }))).toEqual([]);
  });

  test('the same lateral peak on a straight course, or below 10 mph, is not a corner', () => {
    expect(corner(turn(90, { aLatMin: -0.6 }))).toEqual([]);
    expect(corner(turn(180, { aLatMin: -0.65 }, 8))).toEqual([]);
  });

  test('an unknown course (-1) beside the peak confirms nothing: it is no 136° turn', () => {
    const rows = seq([10, { speed: mph(30), course: -1 }], [1, { speed: mph(30), course: 135, yawRateMax: 0.8, aLatMin: -0.6 }], [10, { speed: mph(30), course: -1 }]);
    expect(corner(rows)).toEqual([]);
    const after = seq([10, { speed: mph(30) }], [1, { speed: mph(30), course: -1, yawRateMax: 0.8, aLatMin: -0.6 }], [10, { speed: mph(30), course: -1 }]);
    expect(corner(after)).toEqual([]);
  });

  test('a course jumping faster than 60°/s and past 1 g implied, at 10 mph or more, is the fix, not the car', () => {
    expect(corner(turn(150, { aLatMin: -0.6 }))).toHaveLength(1); // 60°/s: a turn
    expect(corner(turn(151, { aLatMin: -0.6 }))).toEqual([]);
    expect(corner(turn(200, { aLatMin: -0.6 }))).toEqual([]);
  });

  test('the GPS must make at least half the peak plausible: 12° in a second at 30 mph (0.29 g) does not confirm 0.60 g, 13° (0.31 g) does', () => {
    expect(corner(turn(102, { aLatMin: -0.6 }))).toEqual([]);
    expect(corner(turn(103, { aLatMin: -0.6 }))).toHaveLength(1);
  });

  test('the gyroscope must turn with it: speed × yaw rate at least half the peak', () => {
    // 0.60 g at 13.4 m/s needs 0.219 rad/s.
    expect(corner(turn(135, { aLatMin: -0.6, yawRateMax: 0.21 }))).toEqual([]);
    expect(corner(turn(135, { aLatMin: -0.6, yawRateMax: 0.22 }))).toHaveLength(1);
    expect(corner(turn(135, { aLatMin: -0.6, yawRateMax: 0 }))).toEqual([]);
  });

  test('a wobble (past 0.25 g both ways in one second) is not a corner', () => {
    expect(corner(turn(135, { aLatMin: -0.6, aLatMax: 0.3 }))).toEqual([]);
    expect(corner(turn(135, { aLatMin: -0.6, aLatMax: 0.24 }))).toHaveLength(1);
  });

  test('0.70 g with a plausible turn is severe', () => {
    const rows = seq([10, { speed: mph(40) }], [1, { speed: mph(40), course: 150, yawRateMax: 1, aLatMin: -0.7 }], [10, { speed: mph(40), course: 150 }]);
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
    const t = tell(peakDrive({ aLonMin: -0.4 }, 10, 10, mph(35), mph(25)));
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
    const t = tell(seq([10, { speed: mph(40) }], [1, { speed: mph(35), aLonMin: -0.4 }], [1, { speed: mph(28), aLonMin: -0.6 }], [10, { speed: mph(25) }]));
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
    const rows = seq([10, { speed: mph(30), speedAcc: 3 }], [1, { speed: mph(30), course: 135, yawRateMax: 0.8, aLatMin: -0.6, speedAcc: 3 }], [10, { speed: mph(30), course: 135, speedAcc: 3 }]);
    expect(drive(createHarshDetector(counterIds()), rows).all).toEqual([]);
  });
});

describe('before the forward axis is learned, the GPS speed change stands in for the IMU', () => {
  // The fixture rows report no forward extremes (aLonMax = aLonMin = 0) unless told to.
  test('a well-rated 35 → 22 mph drop in a second (0.59 g) is a severe hard brake; 35 → 27 mph (0.36 g) a minor one', () => {
    const severe = seq([10, { speed: mph(35) }], [10, { speed: mph(22) }]);
    expect(only(drive(createHarshDetector(counterIds()), severe).all)).toMatchObject({ type: 'hard_brake', tier: 'severe', startedAt: T0 + 10_000 });
    const minor = seq([10, { speed: mph(35) }], [10, { speed: mph(27) }]);
    expect(only(drive(createHarshDetector(counterIds()), minor).all)).toMatchObject({ type: 'hard_brake', tier: 'minor' });
  });

  test('a well-rated 20 → 29 mph rise in a second (0.41 g) is a hard accel; 20 → 28 mph (0.36 g) is under 0.40 g', () => {
    const rows = seq([10, { speed: mph(20) }], [10, { speed: mph(29) }]);
    expect(only(drive(createHarshDetector(counterIds()), rows).all)).toMatchObject({ type: 'hard_accel', tier: 'minor' });
    expect(drive(createHarshDetector(counterIds()), seq([10, { speed: mph(20) }], [10, { speed: mph(28) }])).all).toEqual([]);
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

describe('the hard events never read the road state (row.road): they are judged at the dry lines, whatever the weather', () => {
  const ROADS: FeatureRow['road'][] = [{ g: 'wet' }, { g: 'water' }, { g: 'snow' }, { g: 'ice', cap: 35 }, { cap: 35 }];
  const stamp = (rows: FeatureRow[], road: FeatureRow['road']): FeatureRow[] => rows.map((r) => ({ ...r, road }));
  /** Every push and every alert, then the flush. */
  const run = (rows: FeatureRow[]) => {
    const det = createHarshDetector(counterIds());
    const pushed = rows.map((r) => ({ out: det.push(r, limit(mph(35)), ctx()), told: det.alerts() }));
    return { pushed, flushed: det.flush() };
  };
  const drives: [string, FeatureRow[]][] = [
    ['a 0.33 g brake (between the snow and dry lines)', peakDrive({ aLonMin: -0.33 }, 10, 10, mph(35), mph(25))],
    ['a 0.40 g brake (past the dry line)', peakDrive({ aLonMin: -0.4 }, 10, 10, mph(35), mph(25))],
    ['a 0.52 g brake (severe on a wet road’s lines, minor dry)', peakDrive({ aLonMin: -0.52 }, 10, 10, mph(40), mph(25))],
    ['a 0.34 g start', peakDrive({ aLonMax: 0.34 }, 10, 10, mph(20), mph(30))],
    ['a 0.45 g turn', seq([10, { speed: mph(30) }], [1, { speed: mph(30), course: 135, yawRateMax: 0.8, aLatMin: -0.45 }], [10, { speed: mph(30), course: 135 }])],
    ['a 0.60 g turn', seq([10, { speed: mph(30) }], [1, { speed: mph(30), course: 135, yawRateMax: 1.2, aLatMin: -0.6 }], [10, { speed: mph(30), course: 135 }])],
    ['the GNSS stand-in, 35 → 27.5 mph (0.34 g)', seq([10, { speed: mph(35) }], [10, { speed: mph(27.5) }])],
  ];

  test.each(drives)('%s: every push, alert and event is the unstamped one', (_name, rows) => {
    const dry = run(rows);
    for (const road of ROADS) expect(run(stamp(rows, road))).toEqual(dry);
  });

  test('no event names a weather line', () => {
    for (const [, rows] of drives) {
      for (const e of drive(createHarshDetector(counterIds()), stamp(rows, { g: 'ice' })).all) expect(Object.keys(e.measured).sort()).toEqual(['peakG', 'speedMph']);
    }
  });
});

describe('the alert-only weather instance (weather: true): the grip’s lines, warnings only', () => {
  const wet = { g: 'wet' } as const;
  /** Push every row through a weather instance (and a scoring one beside it), keeping what each told. */
  const both = (rows: FeatureRow[], c = ctx()) => {
    const weather = createHarshDetector(counterIds(), { weather: true });
    const scoring = createHarshDetector(counterIds());
    const out = rows.map((r) => {
      const events = weather.push(r, limit(mph(35)), c);
      scoring.push(r, limit(mph(35)), c);
      return { events, weather: weather.alerts(), scoring: scoring.alerts() };
    });
    return {
      events: [...out.flatMap((o) => o.events), ...weather.flush()],
      weather: out.flatMap((o, i) => o.weather.map((a) => ({ ...a, row: i }))),
      scoring: out.flatMap((o, i) => o.scoring.map((a) => ({ ...a, row: i }))),
    };
  };

  test('a 0.33 g brake on a wet road is a weather warning (the 0.32 line): tier minor, naming the grip, never an event', () => {
    const got = both(peakDrive({ aLonMin: -0.33, road: wet }, 10, 10, mph(35), mph(25)));
    expect(got.weather).toEqual([{ id: `wx-hard_brake-${T0 + 10_000}`, type: 'hard_brake', tier: 'minor', road: 'wet', row: 10 }]);
    expect(got.events).toEqual([]);
    expect(got.scoring).toEqual([]);
  });

  test('each grip names itself; wet and water warn at the wet lines, snow and ice at the snow lines', () => {
    expect(both(peakDrive({ aLonMin: -0.33, road: { g: 'water' } }, 10, 10, mph(35), mph(25))).weather).toMatchObject([{ type: 'hard_brake', road: 'water' }]);
    for (const g of ['snow', 'ice'] as const) {
      expect(both(peakDrive({ aLonMin: -0.3, road: { g } }, 10, 10, mph(35), mph(25))).weather).toMatchObject([{ type: 'hard_brake', road: g }]);
      expect(both(peakDrive({ aLonMax: 0.33, road: { g } }, 10, 10, mph(20), mph(30))).weather).toMatchObject([{ type: 'hard_accel', road: g }]);
    }
    // 0.30 g is under the wet brake line (0.32), 0.33 g under the wet start line (0.36).
    expect(both(peakDrive({ aLonMin: -0.3, road: wet }, 10, 10, mph(35), mph(25))).weather).toEqual([]);
    expect(both(peakDrive({ aLonMax: 0.33, road: wet }, 10, 10, mph(20), mph(30))).weather).toEqual([]);
  });

  test('past the dry line it says nothing: the scoring detector alerts it, the event that counts', () => {
    const got = both(peakDrive({ aLonMin: -0.4, road: wet }, 10, 10, mph(35), mph(25)));
    expect(got.weather).toEqual([]);
    expect(got.scoring).toEqual([{ id: 'e1', type: 'hard_brake', tier: 'minor', row: 10 }]);
  });

  test('an episode warned under the dry line that then passes it is alerted again by the scoring detector', () => {
    const rows = seq(
      [10, { speed: mph(40), road: wet }],
      [1, { speed: mph(33), aLonMin: -0.33, road: wet }],
      [1, { speed: mph(26), aLonMin: -0.45, road: wet }],
      [10, { speed: mph(26), road: wet }]
    );
    const got = both(rows);
    expect(got.weather).toMatchObject([{ type: 'hard_brake', road: 'wet', row: 10 }]);
    expect(got.scoring).toMatchObject([{ type: 'hard_brake', tier: 'minor', row: 11 }]);
  });

  test('never on an unstamped row, a stamp of sight alone, or a stamp it does not know', () => {
    expect(both(peakDrive({ aLonMin: -0.33 }, 10, 10, mph(35), mph(25))).weather).toEqual([]);
    expect(both(peakDrive({ aLonMin: -0.33, road: { cap: 35 } }, 10, 10, mph(35), mph(25))).weather).toEqual([]);
    expect(both(peakDrive({ aLonMin: -0.33, road: { g: 'mud' } as unknown as FeatureRow['road'] }, 10, 10, mph(35), mph(25))).weather).toEqual([]);
  });

  test('every gate holds: no GNSS confirmation, a spike, the warm-up, a poor fix, under 5 mph', () => {
    expect(both(peakDrive({ aLonMin: -0.33, road: wet }, 10, 10)).weather).toEqual([]);
    const spiked = seq([10, { speed: mph(35) }], [1, { speed: mph(25), aLonMin: -0.33, road: wet, gravityStability: 0.2 }], [10, { speed: mph(25) }]);
    expect(both(spiked).weather).toEqual([]);
    expect(both(peakDrive({ aLonMin: -0.33, road: wet }, 10, 10, mph(35), mph(25)), ctx({ warmupEndsAt: T0 + 30_000 })).weather).toEqual([]);
    expect(both(peakDrive({ aLonMin: -0.33, road: wet, hAcc: 30 }, 10, 10, mph(35), mph(25))).weather).toEqual([]);
    expect(both(peakDrive({ aLonMin: -0.33, road: wet }, 10, 10, mph(4), mph(2))).weather).toEqual([]);
  });

  test('a 0.45 g turn on a wet road warns at 0.43; under 10 mph it does not', () => {
    const turn = (v: number) => seq([10, { speed: mph(v) }], [1, { speed: mph(v), course: 135, yawRateMax: 3, aLatMin: -0.45, road: wet }], [10, { speed: mph(v), course: 135 }]);
    expect(both(turn(30)).weather).toMatchObject([{ type: 'hard_corner', tier: 'minor', road: 'wet', row: 10 }]);
    expect(both(turn(30)).scoring).toEqual([]);
    expect(both(turn(8)).weather).toEqual([]);
  });

  test('before the forward axis is learned, the GNSS stand-in warns too: 35 → 27.5 mph (0.34 g) on a wet road', () => {
    const got = both(seq([10, { speed: mph(35), road: wet }], [10, { speed: mph(27.5), road: wet }]));
    expect(got.weather).toMatchObject([{ type: 'hard_brake', road: 'wet', row: 10 }]);
    expect(got.scoring).toEqual([]);
  });

  test('it never takes an event id', () => {
    let taken = 0;
    const det = createHarshDetector(() => `e${(taken += 1)}`, { weather: true });
    for (const r of peakDrive({ aLonMin: -0.33, road: wet }, 10, 10, mph(35), mph(25))) det.push(r, limit(mph(35)), ctx());
    det.flush();
    expect(taken).toBe(0);
  });
});

describe('a course turning fast at low speed is a tight turn, not a jump: a jump also implies more than 1 g sideways', () => {
  const events = (rows: FeatureRow[]) => drive(createHarshDetector(counterIds()), rows).all;
  // 15 mph (6.7 m/s) on a 6 m radius: 1.12 rad/s, 64°/s, 0.76 g.
  const tight = (to: number) =>
    seq([10, { speed: mph(15) }], [1, { speed: mph(15), course: to, yawRateMax: 1.12, aLatMin: -0.76 }], [10, { speed: mph(15), course: to }]);

  test('15 mph on a 6 m radius (64°/s, 0.76 g) is a hard corner', () => {
    const e = only(events(tight(154)));
    expect(e).toMatchObject({ type: 'hard_corner', tier: 'severe' });
    expect(e.measured).toEqual({ peakG: 0.76, speedMph: 15 });
  });

  test('a course change past 60°/s that implies more than 1 g is still the fix: 150°/s at 15 mph (1.8 g)', () => {
    expect(events(tight(240))).toEqual([]);
  });
});

describe('before the forward axis is learned (no sideways extremes), speed × yaw rate is the turn, confirmed by the GPS course', () => {
  const events = (rows: FeatureRow[], c = ctx()) => drive(createHarshDetector(counterIds()), rows, undefined, c).all;
  // 25 mph (11.2 m/s) on a 20 m radius: 0.56 rad/s (32°/s), 0.64 g. The rows report no IMU extremes.
  const turn = (step: number, over: Partial<FeatureRow> = {}, yaw = 0.56, v = 25) =>
    seq(
      [10, { speed: mph(v) }],
      [3, (i) => ({ speed: mph(v), course: (360 + 90 + step * (i - 9)) % 360, yawRateMax: yaw, ...over })],
      [10, { speed: mph(v), course: (360 + 90 + step * 3) % 360 }]
    );

  test('a 0.64 g right turn and a 0.64 g left turn are each one minor hard corner', () => {
    for (const step of [32, -32]) {
      const e = only(events(turn(step)));
      expect(e).toMatchObject({ type: 'hard_corner', tier: 'minor', startedAt: T0 + 10_000, durationS: 3 });
      expect(e.measured).toEqual({ peakG: 0.64, speedMph: 25 });
    }
  });

  test('the phone turned in the hand with the course straight is nothing, with or without an orientation spike', () => {
    expect(events(turn(0, {}, 1))).toEqual([]);
    expect(events(turn(0, { orientationDelta: 0.9 }, 1))).toEqual([]);
  });

  test('the course must reach the line too: 1.1 g of yaw with the course turning 10°/s (0.23 g) is nothing', () => {
    expect(events(turn(10, {}, 0.8, 30))).toEqual([]);
  });

  test('a phone turning in the hand or sliding in a cup holder during an ordinary bend is nothing: the course bounds the yaw', () => {
    // 30 mph: 11°/s (0.26 g) under 0.38 rad/s of yaw (0.52 g); 15°/s (0.36 g) under 0.52 rad/s (0.71 g).
    expect(events(turn(11, {}, 0.38, 30))).toEqual([]);
    expect(events(turn(-11, {}, 0.38, 30))).toEqual([]);
    expect(events(turn(15, {}, 0.52, 30))).toEqual([]);
    // A 0.30 g bend (12.6°/s) with a 0.2 rad/s wobble on top of its 0.22 rad/s of yaw (0.57 g).
    expect(events(turn(12.6, {}, 0.42, 30))).toEqual([]);
    // 12 mph through an intersection at 26°/s (0.25 g) under 0.9 rad/s (0.49 g).
    expect(events(turn(26, {}, 0.9, 12))).toEqual([]);
  });

  test('the force is the lesser of the two: 1.14 g of yaw over a 0.64 g course turn is a minor 0.64 g corner', () => {
    expect(only(events(turn(32, {}, 1)))).toMatchObject({ tier: 'minor', measured: { peakG: 0.64, speedMph: 25 } });
  });

  test('15 mph on a 6 m radius (64°/s, 0.76 g) is a severe corner here too', () => {
    expect(only(events(turn(64, {}, 1.12, 15)))).toMatchObject({ tier: 'severe', measured: { peakG: 0.76, speedMph: 15 } });
  });

  test('the corner gates still hold: under the line, under 10 mph, a spike, the warm-up, a poor fix, an untrusted speed', () => {
    // 0.47 g of yaw at 25 mph.
    expect(events(turn(32, {}, 0.41))).toEqual([]);
    expect(events(turn(60, {}, 2, 8))).toEqual([]);
    expect(events(turn(32, { gravityStability: 0.2 }))).toEqual([]);
    expect(events(turn(32), ctx({ warmupEndsAt: T0 + 30_000 }))).toEqual([]);
    expect(events(turn(32, { hAcc: 30 }))).toEqual([]);
    expect(events(turn(32, { speedAcc: 3 }))).toEqual([]);
  });

  test('the weather instance reads the yaw too: 0.45 g of yaw on a wet road is a weather warning (0.43), no event either way', () => {
    // 0.395 rad/s at 25 mph is 0.45 g; the course 23°/s (0.45 g).
    expect(events(turn(23, {}, 0.395))).toEqual([]);
    expect(events(turn(23, { road: { g: 'wet' } }, 0.395))).toEqual([]);
    const det = createHarshDetector(counterIds(), { weather: true });
    const told = turn(23, { road: { g: 'wet' } }, 0.395).flatMap((r) => {
      expect(det.push(r, limit(mph(35)), ctx())).toEqual([]);
      return det.alerts();
    });
    expect(told).toMatchObject([{ type: 'hard_corner', tier: 'minor', road: 'wet' }]);
  });

  test('a row with sideways extremes is judged by them alone, as before', () => {
    // The yaw says 0.64 g, the learned axis 0.30 g: no corner.
    expect(events(turn(32, { aLatMin: -0.3 }))).toEqual([]);
  });
});
