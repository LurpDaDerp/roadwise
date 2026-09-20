import { CONSTANTS, severity } from '@scoring';
import { createSpeedingDetector } from '@/core/detectors/speeding';
import { NO_LIMIT, T0, counterIds, ctx, drive, limit, mph, only, row, seq } from '../__fixtures__/rows';

const L35 = limit(mph(35)); // over once speed > 35 + 5 mph
const OVER = { speed: mph(45) };
const UNDER = { speed: mph(30) };
const make = () => createSpeedingDetector(counterIds());

describe('episode length', () => {
  test('four rows over is not an episode', () => {
    expect(drive(make(), seq([4, OVER], [1, UNDER]), L35).all).toEqual([]);
  });

  test('exactly five rows over closes into one event on the first row back under', () => {
    const { pushed, flushed } = drive(make(), seq([5, OVER], [1, UNDER]), L35);
    expect(pushed.slice(0, 5).flat()).toEqual([]);
    expect(flushed).toEqual([]);
    const e = only(pushed[5]!);
    expect(e).toMatchObject({
      id: 'e1',
      category: 'speeding',
      startedAt: T0,
      durationS: 5,
      q: 0.9,
      corrected: false,
      status: 'scored',
      alertable: true,
      source: 'gnss',
      context: { night: false, precipitation: false },
    });
    expect(e.measured.overMps).toBeCloseTo(mph(10), 9); // over the limit, not the tolerance line
    expect(e.measured.limitMps).toBeCloseTo(mph(35), 9);
    expect(e.measured.speedMps).toBeCloseTo(mph(45), 9);
  });

  test('flush closes an open episode at trip end', () => {
    const { pushed, flushed } = drive(make(), seq([5, OVER]), L35);
    expect(pushed.flat()).toEqual([]);
    expect(only(flushed)).toMatchObject({ durationS: 5, startedAt: T0 });
  });

  test('two episodes are two events with their own ids and starts', () => {
    const { all } = drive(make(), seq([6, OVER], [2, UNDER], [5, OVER], [1, UNDER]), L35);
    expect(all.map((e) => [e.id, e.startedAt, e.durationS])).toEqual([
      ['e1', T0, 6],
      ['e2', T0 + 8000, 5],
    ]);
  });
});

describe('what counts as over', () => {
  test('speed exactly at limit + tolerance is not over; a hair above is', () => {
    const edge = mph(35) + CONSTANTS.SPEEDING_TOLERANCE_MPS;
    expect(drive(make(), seq([6, { speed: edge }]), L35).all).toEqual([]);
    expect(drive(make(), seq([6, { speed: edge + 0.01 }]), L35).all).toHaveLength(1);
  });

  test('an episode that opens just above the line records an over-limit just above the tolerance', () => {
    const edge = mph(35) + CONSTANTS.SPEEDING_TOLERANCE_MPS;
    const e = only(drive(make(), seq([6, { speed: edge + 0.01 }]), L35).all);
    expect(e.measured.overMps).toBeCloseTo(CONSTANTS.SPEEDING_TOLERANCE_MPS + 0.01, 9);
    expect(e.measured.limitMps).toBeCloseTo(mph(35), 9);
  });

  test('an unknown limit never opens an episode', () => {
    expect(drive(make(), seq([10, OVER]), NO_LIMIT).all).toEqual([]);
    expect(drive(make(), seq([10, OVER]), limit(null, 'posted')).all).toEqual([]);
  });

  test('an unknown limit, an invalid fix or an unknown speed mid-episode closes it', () => {
    const lim = (_r: unknown, i: number) => (i === 3 ? NO_LIMIT : L35);
    expect(drive(make(), seq([8, OVER]), lim).all).toEqual([]);
    expect(
      drive(make(), seq([3, OVER], [1, { ...OVER, gnssValid: false }], [4, OVER]), L35).all
    ).toEqual([]);
    expect(drive(make(), seq([3, OVER], [1, { speed: -1 }], [4, OVER]), L35).all).toEqual([]);
  });
});

describe('measured values', () => {
  test('overMps is the episode maximum and the episode ends on the first row not over', () => {
    const speeds = [45, 50, 55, 48, 45, 38];
    const list = seq(...speeds.map((s) => [1, { speed: mph(s) }] as const));
    const e = only(drive(make(), list, L35).all);
    expect(e.durationS).toBe(5);
    expect(e.measured.overMps).toBeCloseTo(mph(20), 9);
    expect(e.measured.speedMps).toBeCloseTo(mph(55), 9);
  });

  test('when the limit changes mid-episode, limitMps is the one at the max-over row', () => {
    const lim = (_r: unknown, i: number) => (i < 3 ? limit(mph(35)) : limit(mph(30)));
    const e = only(drive(make(), seq([6, { speed: mph(55) }], [1, UNDER]), lim).all);
    expect(e.measured.overMps).toBeCloseTo(mph(25), 9);
    expect(e.measured.limitMps).toBeCloseTo(mph(30), 9);
  });

  test('spec §9.4 worked example: 47 in a 35 for 45 s is 12 mph over and severity 2', () => {
    const e = only(drive(make(), seq([45, { speed: mph(47) }], [1, UNDER]), L35).all);
    expect(e).toMatchObject({ durationS: 45, q: 0.9, status: 'scored' });
    expect(e.measured.overMps).toBeCloseTo(mph(12), 9);
    expect(e.measured.limitMps).toBeCloseTo(mph(35), 9);
    expect(severity(e)).toBe(2);
  });
});

describe('confidence', () => {
  test.each([
    ['posted single road', limit(mph(35)), 0.9, true],
    ['posted with parallel roads', limit(mph(35), 'posted', { parallelRoads: true }), 0.6, false],
    [
      'posted with low match confidence',
      limit(mph(35), 'posted', { matchConfidence: 0.69 }),
      0.6,
      false,
    ],
    [
      'posted at the match-confidence edge',
      limit(mph(35), 'posted', { matchConfidence: 0.7 }),
      0.9,
      true,
    ],
    ['statutory', limit(mph(35), 'statutory'), 0.7, false],
    ['cached', limit(mph(35), 'cached'), 0.8, true],
  ])('%s → q %p, alertable %p', (_name, lim, q, alertable) => {
    const e = only(drive(make(), seq([5, OVER], [1, UNDER]), lim).all);
    expect(e).toMatchObject({ q, alertable, status: 'scored' });
  });

  test('the weakest limit source in the episode sets the confidence', () => {
    const lim = (_r: unknown, i: number) => (i === 2 ? limit(mph(35), 'statutory') : L35);
    expect(only(drive(make(), seq([5, OVER], [1, UNDER]), lim).all)).toMatchObject({ q: 0.7 });
  });

  test('poor GNSS on any row caps q at 0.4: possible and not alertable', () => {
    const hAcc = seq([2, OVER], [1, { ...OVER, hAcc: 30 }], [2, OVER], [1, UNDER]);
    expect(only(drive(make(), hAcc, L35).all)).toMatchObject({
      q: 0.4,
      alertable: false,
      status: 'possible',
    });
    const speedAcc = seq([4, OVER], [1, { ...OVER, speedAcc: 2.1 }], [1, UNDER]);
    expect(only(drive(make(), speedAcc, L35).all)).toMatchObject({
      q: 0.4,
      alertable: false,
      status: 'possible',
    });
  });

  test('GNSS exactly at the accuracy edges is not capped', () => {
    const edges = seq([5, { ...OVER, hAcc: 20, speedAcc: 2 }], [1, UNDER]);
    expect(only(drive(make(), edges, L35).all)).toMatchObject({
      q: 0.9,
      alertable: true,
      status: 'scored',
    });
  });
});

describe('correction credit', () => {
  test('an episode that ends within SPEEDING_GRACE_S of the alert is corrected', () => {
    const det = make();
    seq([8, OVER]).forEach((r) => det.push(r, L35, ctx())); // over covers T0 .. T0+8000
    expect(det.openEpisodeId()).toBe('e1');
    det.markAlerted('e1', T0 + 5000);
    const e = only(det.push(row(UNDER, 8), L35, ctx())); // ended 3 s after the alert
    expect(e).toMatchObject({ corrected: true, durationS: 8 });
    expect(det.openEpisodeId()).toBeNull();
  });

  test('ending exactly SPEEDING_GRACE_S after the alert still counts', () => {
    const det = make();
    seq([15, OVER]).forEach((r) => det.push(r, L35, ctx())); // over covers T0 .. T0+15000
    det.markAlerted('e1', T0 + 5000);
    expect(only(det.push(row(UNDER, 15), L35, ctx()))).toMatchObject({ corrected: true });
  });

  test('ending later than the grace window is not corrected', () => {
    const det = make();
    seq([16, OVER]).forEach((r) => det.push(r, L35, ctx())); // over covers T0 .. T0+16000
    det.markAlerted('e1', T0 + 5000);
    expect(only(det.push(row(UNDER, 16), L35, ctx()))).toMatchObject({ corrected: false });
  });

  test('the latest alert is the one the grace window is measured from', () => {
    const det = make();
    seq([20, OVER]).forEach((r) => det.push(r, L35, ctx())); // over covers T0 .. T0+20000
    det.markAlerted('e1', T0 + 5000);
    det.markAlerted('e1', T0 + 15000);
    expect(only(det.push(row(UNDER, 20), L35, ctx()))).toMatchObject({ corrected: true });
  });

  test('an alert for a foreign id leaves the episode uncorrected', () => {
    const det = make();
    seq([6, OVER]).forEach((r) => det.push(r, L35, ctx()));
    det.markAlerted('nope', T0 + 5000);
    expect(only(det.push(row(UNDER, 6), L35, ctx()))).toMatchObject({ corrected: false });
  });

  test('openEpisodeId is null until the episode reaches SPEEDING_MIN_S rows', () => {
    const det = make();
    seq([4, OVER]).forEach((r) => det.push(r, L35, ctx()));
    expect(det.openEpisodeId()).toBeNull();
    det.push(row(OVER, 4), L35, ctx());
    expect(det.openEpisodeId()).toBe('e1');
  });
});

test('context is taken from the row that opened the episode', () => {
  const c = (_r: unknown, i: number) => ctx({ night: i === 0, precipitation: i > 0 });
  const e = only(drive(make(), seq([5, OVER], [1, UNDER]), L35, c).all);
  expect(e.context).toEqual({ night: true, precipitation: false });
});
