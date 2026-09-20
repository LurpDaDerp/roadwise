import { CONSTANTS, severity } from '@scoring';
import { createPhoneUseDetector } from '@/core/detectors/phoneUse';
import { T0, counterIds, ctx, drive, only, seq } from '../__fixtures__/rows';

const HAND = { handlingScore: 0.7 };
const QUIET = {};
const make = () => createPhoneUseDetector(counterIds());

describe('handling', () => {
  test('three handling rows while moving → one phone event once two quiet rows follow', () => {
    const { pushed, flushed } = drive(make(), seq([3, HAND], [2, QUIET]));
    expect(pushed.slice(0, 4).flat()).toEqual([]);
    expect(flushed).toEqual([]);
    const e = only(pushed[4]!);
    expect(e).toMatchObject({
      id: 'e1',
      category: 'phone',
      startedAt: T0,
      durationS: 3,
      q: 0.6,
      corrected: false,
      status: 'scored',
      alertable: false,
      source: 'imu',
      measured: { speedMps: 15 },
      context: { night: false, precipitation: false },
    });
    expect(severity(e)).toBe(1); // 15 m/s is above 25 mph
  });

  test('two handling rows are not enough', () => {
    expect(drive(make(), seq([2, HAND], [3, QUIET])).all).toEqual([]);
  });

  test('handlingScore exactly 0.6 counts; 0.59 does not', () => {
    expect(drive(make(), seq([3, { handlingScore: 0.6 }], [2, QUIET])).all).toHaveLength(1);
    expect(drive(make(), seq([3, { handlingScore: 0.59 }], [2, QUIET])).all).toEqual([]);
  });

  test('unlock evidence on any row raises q to 0.9 and makes the event alertable', () => {
    const list = seq(
      [1, HAND],
      [1, { ...HAND, locked: false, screenOn: true }],
      [1, HAND],
      [2, QUIET]
    );
    expect(only(drive(make(), list).all)).toMatchObject({
      q: 0.9,
      alertable: true,
      source: 'both',
      status: 'scored',
    });
  });

  test('a lit screen that is still locked is not unlock evidence', () => {
    const list = seq([3, { ...HAND, screenOn: true }], [2, QUIET]);
    expect(only(drive(make(), list).all)).toMatchObject({ q: 0.6, source: 'imu' });
  });

  test('one quiet row inside the episode does not end it', () => {
    const list = seq([3, HAND], [1, QUIET], [2, HAND], [2, QUIET]);
    expect(only(drive(make(), list).all)).toMatchObject({ durationS: 6 });
  });

  test('two quiet rows end it and are not counted; a new run is a new event', () => {
    const { all } = drive(make(), seq([4, HAND], [2, QUIET], [3, HAND], [2, QUIET]));
    expect(all.map((e) => [e.id, e.startedAt, e.durationS])).toEqual([
      ['e1', T0, 4],
      ['e2', T0 + 6000, 3],
    ]);
  });

  test('speedMps is the mean speed over the episode', () => {
    const list = seq([3, (i: number) => ({ ...HAND, speed: [10, 20, 30][i]! })], [2, { speed: 30 }]);
    expect(only(drive(make(), list).all).measured.speedMps).toBeCloseTo(20, 12);
  });

  test('flush closes an open episode', () => {
    const { pushed, flushed } = drive(make(), seq([3, HAND]));
    expect(pushed.flat()).toEqual([]);
    expect(only(flushed)).toMatchObject({ durationS: 3 });
  });

  test('an unknown speed row breaks the handling run', () => {
    const list = seq([2, HAND], [1, { ...HAND, gnssValid: false }], [2, HAND], [2, QUIET]);
    expect(drive(make(), list).all).toEqual([]);
  });
});

describe('speed bands', () => {
  test('between lockout and 10 mph handling is scored at the row speed (0.3 severity band)', () => {
    const e = only(drive(make(), seq([3, { ...HAND, speed: 3 }], [2, { speed: 3 }])).all);
    expect(e).toMatchObject({ status: 'scored', measured: { speedMps: 3 } });
    expect(severity(e)).toBe(0.3);
  });

  test('at exactly PHONE_MIN_SPEED_MPS the 0.7 band applies', () => {
    const v = CONSTANTS.PHONE_MIN_SPEED_MPS;
    const e = only(drive(make(), seq([3, { ...HAND, speed: v }], [2, { speed: v }])).all);
    expect(e.measured.speedMps).toBeCloseTo(v, 12);
    expect(severity(e)).toBe(0.7);
  });

  test('while stopped the same signal is logged as possible at speed 0', () => {
    const e = only(drive(make(), seq([3, { ...HAND, speed: 0 }], [2, { speed: 0 }])).all);
    expect(e).toMatchObject({
      status: 'possible',
      q: 0.6,
      alertable: false,
      durationS: 3,
      measured: { speedMps: 0 },
    });
    expect(severity(e)).toBe(0);
  });

  test('stopped and moving handling are separate episodes', () => {
    const { all } = drive(make(), seq([3, { ...HAND, speed: 0 }], [3, HAND], [2, QUIET]));
    expect(all.map((e) => [e.status, e.startedAt, e.durationS, e.measured.speedMps])).toEqual([
      ['possible', T0, 3, 0],
      ['scored', T0 + 3000, 3, 15],
    ]);
  });

  test('speed exactly at LOCKOUT_SPEED_MPS is moving; a hair below is stopped', () => {
    const lock = CONSTANTS.LOCKOUT_SPEED_MPS;
    const atSpeed = (speed: number) => seq([3, { ...HAND, speed }], [2, { speed }]);
    expect(only(drive(make(), atSpeed(lock)).all)).toMatchObject({ status: 'scored' });
    expect(only(drive(make(), atSpeed(lock - 0.01)).all)).toMatchObject({
      status: 'possible',
      measured: { speedMps: 0 },
    });
  });
});

describe('app switch', () => {
  const AWAY = { appForeground: false };

  test('in mounted mode, RoadWise in the background while moving is an episode until it returns', () => {
    const { pushed, flushed } = drive(make(), seq([4, AWAY], [3, {}]));
    expect(pushed.slice(0, 5).flat()).toEqual([]);
    expect(flushed).toEqual([]);
    expect(only(pushed[5]!)).toMatchObject({
      category: 'phone',
      startedAt: T0,
      durationS: 4,
      q: 0.9,
      status: 'scored',
      alertable: true,
      source: 'os',
      measured: { speedMps: 15 },
    });
  });

  test('needs no run-up: a single background row is an event', () => {
    expect(only(drive(make(), seq([1, AWAY], [2, {}])).all)).toMatchObject({
      durationS: 1,
      q: 0.9,
    });
  });

  test.each(['pocket', 'auto'] as const)('is ignored in %s mode', (mode) => {
    expect(drive(make(), seq([4, AWAY], [3, {}]), undefined, ctx({ mode })).all).toEqual([]);
  });

  test('while stopped it is only possible', () => {
    const list = seq([4, { ...AWAY, speed: 0 }], [3, { speed: 0 }]);
    expect(only(drive(make(), list).all)).toMatchObject({
      status: 'possible',
      q: 0.9,
      alertable: false,
      measured: { speedMps: 0 },
    });
  });

  test('handling and an app switch in the same window are one event with both kinds of evidence', () => {
    expect(only(drive(make(), seq([3, { ...HAND, ...AWAY }], [2, {}])).all)).toMatchObject({
      q: 0.9,
      source: 'both',
      durationS: 3,
    });
  });
});
