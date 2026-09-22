import { CONSTANTS, severity } from '@scoring';
import { APP_SWITCH_CONFIRM_S, createPhoneUseDetector } from '@/core/detectors/phoneUse';
import { NO_LIMIT, T0, counterIds, ctx, drive, only, seq } from '../__fixtures__/rows';

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
  // Backgrounded on an unlocked, lit screen: M3 no longer counts a locked phone (I11).
  const AWAY = { appForeground: false, locked: false, screenOn: true };

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

describe('openEpisode', () => {
  const step = (det: ReturnType<typeof make>, r: Parameters<typeof det.push>[0], c = ctx()) => {
    det.push(r, NO_LIMIT, c);
    return det.openEpisode();
  };

  test('null until the run confirms, then the id and the rows through the last signal', () => {
    const det = make();
    const seen = seq([3, HAND], [1, QUIET], [1, HAND], [2, QUIET]).map((r) => step(det, r));
    expect(seen).toEqual([
      null,
      null,
      { id: 'e1', durationS: 3 },
      { id: 'e1', durationS: 3 }, // a quiet row keeps the episode open but adds nothing
      { id: 'e1', durationS: 5 },
      { id: 'e1', durationS: 5 },
      null, // the second quiet row closed it
    ]);
  });

  test('an app switch in mounted mode confirms on its first row', () => {
    const det = make();
    const seen = seq([2, { appForeground: false, locked: false, screenOn: true }]).map((r) =>
      step(det, r, ctx({ mode: 'mounted' }))
    );
    expect(seen).toEqual([
      { id: 'e1', durationS: 1 },
      { id: 'e1', durationS: 2 },
    ]);
  });

  test('a run that breaks before confirming exposes nothing', () => {
    const det = make();
    expect(seq([2, HAND], [1, QUIET]).map((r) => step(det, r))).toEqual([null, null, null]);
  });
});

describe('M3: a locked phone is never phone use (I11)', () => {
  const SWITCHED = { appForeground: false, locked: false, screenOn: true };
  const LOCKED = { appForeground: false, locked: true, screenOn: false };
  const BACK = { appForeground: true, locked: false, screenOn: true };
  const LAGGED = ctx({ lockLagged: true });
  const UNRELIABLE = ctx({ lockReliable: false });

  test('reliable signal: a backgrounded app on a locked phone, or a dark screen, is nothing', () => {
    expect(drive(make(), seq([60, LOCKED], [3, {}])).all).toEqual([]);
    expect(drive(make(), seq([5, { appForeground: false, locked: false, screenOn: false }], [3, {}])).all).toEqual([]);
  });

  test(`lagged signal: a side-button press that reports locked within ${APP_SWITCH_CONFIRM_S} s is dropped`, () => {
    // iOS: the app backgrounds at once, `locked` arrives about ten seconds later.
    const det = make();
    const rows = seq([APP_SWITCH_CONFIRM_S - 1, SWITCHED], [60, LOCKED], [3, {}]);
    const seen = rows.map((r) => {
      const out = det.push(r, NO_LIMIT, LAGGED);
      return { out, open: det.openEpisode() };
    });
    expect(seen.every((x) => x.out.length === 0 && x.open === null)).toBe(true);
    expect(det.flush()).toEqual([]);
  });

  test('lagged signal: a switch that returns before the confirmation is dropped too', () => {
    expect(drive(make(), seq([APP_SWITCH_CONFIRM_S - 1, SWITCHED], [5, BACK]), NO_LIMIT, LAGGED).all).toEqual([]);
  });

  test(`lagged signal: the ${APP_SWITCH_CONFIRM_S}th backgrounded, unlocked row confirms, covering every row`, () => {
    const det = make();
    const rows = seq([20, SWITCHED], [3, BACK]);
    const opens = rows.map((r) => {
      det.push(r, NO_LIMIT, LAGGED);
      return det.openEpisode();
    });
    expect(opens.slice(0, APP_SWITCH_CONFIRM_S - 1).every((o) => o === null)).toBe(true);
    expect(opens[APP_SWITCH_CONFIRM_S - 1]).toEqual({ id: 'e1', durationS: APP_SWITCH_CONFIRM_S });
    expect(opens[19]).toEqual({ id: 'e1', durationS: 20 });
    expect(only(drive(make(), rows, NO_LIMIT, LAGGED).all)).toMatchObject({
      startedAt: T0,
      durationS: 20,
      q: 0.9,
      source: 'os',
      status: 'scored',
    });
  });

  test('lagged signal: held-back rows never lengthen an episode handling already confirmed', () => {
    // Handled for 3 s, then the side button: the ten lagging rows add nothing, the lock closes it.
    const rows = seq([3, { ...HAND, ...BACK }], [10, SWITCHED], [3, LOCKED]);
    expect(only(drive(make(), rows, NO_LIMIT, LAGGED).all)).toMatchObject({ durationS: 3, q: 0.9 });
  });

  test('unreliable signal: a backgrounded app is not evidence at all, however long', () => {
    // An iPhone without a passcode never reports locked: backgrounded and locked look the same.
    expect(drive(make(), seq([120, SWITCHED], [3, {}]), NO_LIMIT, UNRELIABLE).all).toEqual([]);
  });

  test('unreliable signal: real handling still counts, at handling confidence — a lit screen is no unlock', () => {
    const e = only(drive(make(), seq([4, { ...HAND, ...BACK }], [3, {}]), NO_LIMIT, UNRELIABLE).all);
    expect(e).toMatchObject({ durationS: 4, q: 0.6, source: 'imu' });
  });
});

describe('M3: SR8 — RoadWise opened at speed on a trip that is not mounted', () => {
  const OPEN = { appForeground: true, locked: false, screenOn: true };

  test.each(['pocket', 'auto'] as const)('%s: the opening row is one q 0.9 event from the OS', (mode) => {
    const e = only(drive(make(), seq([5, {}], [6, OPEN], [3, {}]), NO_LIMIT, ctx({ mode })).all);
    expect(e).toMatchObject({
      category: 'phone',
      startedAt: T0 + 5000,
      durationS: 1,
      q: 0.9,
      source: 'os',
      status: 'scored',
      alertable: true,
    });
  });

  test('mounted: the same rows are a driver looking at the HUD they mounted — nothing', () => {
    expect(drive(make(), seq([5, {}], [6, OPEN], [3, {}]), NO_LIMIT, ctx({ mode: 'mounted' })).all).toEqual([]);
  });

  test('below the lockout speed, or on the first row of a trip, opening the app is nothing', () => {
    const slow = { speed: CONSTANTS.LOCKOUT_SPEED_MPS - 0.01 };
    const pocket = ctx({ mode: 'pocket' });
    expect(drive(make(), seq([5, slow], [6, { ...OPEN, ...slow }], [3, slow]), NO_LIMIT, pocket).all).toEqual([]);
    expect(drive(make(), seq([6, OPEN], [3, {}]), NO_LIMIT, pocket).all).toEqual([]);
  });

  test('handling while it is open extends it; locking and reopening is a second episode', () => {
    const pocket = ctx({ mode: 'pocket' });
    const extended = drive(make(), seq([5, {}], [1, OPEN], [4, { ...OPEN, ...HAND }], [3, {}]), NO_LIMIT, pocket);
    expect(only(extended.all)).toMatchObject({ durationS: 5, q: 0.9, source: 'both' });
    const twice = drive(make(), seq([5, {}], [2, OPEN], [5, {}], [2, OPEN], [3, {}]), NO_LIMIT, pocket);
    expect(twice.all.map((e) => [e.startedAt - T0, e.durationS])).toEqual([
      [5000, 1],
      [12000, 1],
    ]);
  });

  test('E1 M2: on an unreliable lock signal a screen waking over RoadWise is not an opening', () => {
    // An Android phone with no keyguard: `locked` never turns true, RoadWise stays in front with
    // the screen off, and a notification lights it at speed. Nobody opened anything.
    const dark = { appForeground: true, locked: false, screenOn: false };
    const lit = { appForeground: true, locked: false, screenOn: true };
    const unreliable = ctx({ mode: 'pocket', lockReliable: false });
    expect(drive(make(), seq([5, dark], [4, lit], [3, dark]), NO_LIMIT, unreliable).all).toEqual([]);
    // Negative control: with a lock signal to believe, the same lit screen is an unlock-and-open.
    const reliable = ctx({ mode: 'pocket', lockReliable: true });
    const locked = { appForeground: true, locked: true, screenOn: false };
    expect(drive(make(), seq([5, locked], [4, lit], [3, locked]), NO_LIMIT, reliable).all).toHaveLength(1);
  });

  test('also on an unreliable lock signal: the app coming to the front is what counts', () => {
    const e = only(
      drive(make(), seq([5, { appForeground: false, locked: false, screenOn: true }], [4, OPEN], [3, {}]), NO_LIMIT, ctx({ mode: 'pocket', lockReliable: false })).all
    );
    expect(e).toMatchObject({ durationS: 1, q: 0.9, source: 'os' });
  });
});
