import { createPhoneUseDetector } from '@/core/detectors/phoneUse';
import { counterIds, ctx, drive, mph, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';

const handled = { handlingScore: 0.9, gravityStability: 0.6, orientationDelta: 0.2 };
/** A navigation app opened with the navigation button: unlocked, screen on, RoadWise in the background, the rows stamped. */
const navigation = { locked: false, screenOn: true, appForeground: false, exempt: 'nav' } as const;

describe('phone pickup and handling (spec event table, "Rules against false positives")', () => {
  test('8 s of handling at 35 mph is one pickup of 8 s (−40), no handling event', () => {
    const rows = seq([10, { speed: mph(35) }], [8, { speed: mph(35), ...handled }], [10, { speed: mph(35) }]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'phone_pickup', tier: 'severe', startedAt: T0 + 10_000, durationS: 8 });
    expect(e.stoppedInTraffic).toBeUndefined();
    expect(e.measured).toEqual({ mounted: false, speedMph: 35, maxSpeedMph: 35 });
  });

  test('handling past 15 s adds a phone_handling event in 15-s units: 40 s → moderate? no: >30 s is severe, 2 units', () => {
    const rows = seq([10, { speed: mph(35) }], [40, { speed: mph(35), ...handled }], [10, { speed: mph(35) }]);
    const { all } = drive(createPhoneUseDetector(counterIds()), rows);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ type: 'phone_pickup', durationS: 40 });
    expect(all[1]).toMatchObject({ type: 'phone_handling', tier: 'severe', startedAt: T0 + 25_000, durationS: 25, units: 2 });
    const short = seq([10, { speed: mph(35) }], [20, { speed: mph(35), ...handled }], [10, { speed: mph(35) }]);
    const two = drive(createPhoneUseDetector(counterIds()), short).all;
    expect(two[1]).toMatchObject({ type: 'phone_handling', tier: 'moderate', durationS: 5, units: 1 });
  });

  test('a tap of under 3 s on a mounted, stable phone is not a pickup', () => {
    const tap = seq([10, { speed: mph(35) }], [2, { speed: mph(35), handlingScore: 0.8 }], [10, { speed: mph(35) }]);
    expect(drive(createPhoneUseDetector(counterIds()), tap).all).toEqual([]);
  });

  test('stopped in traffic mid-drive, after having moved: a pickup with stoppedInTraffic (−20)', () => {
    const rows = seq([10, { speed: mph(35) }], [5, { speed: 0 }], [6, { speed: 0, ...handled }], [10, { speed: 0 }], [5, { speed: mph(35) }]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'phone_pickup', stoppedInTraffic: true });
  });

  test('handling before the car has ever moved is parking-lot use, not a pickup', () => {
    const rows = seq([5, { speed: 0 }], [10, { speed: 0, ...handled }], [10, { speed: 0 }], [10, { speed: mph(35) }]);
    expect(drive(createPhoneUseDetector(counterIds()), rows).all).toEqual([]);
  });

  test('a hands-free call suppresses phone events; so does the warm-up and a poor fix', () => {
    const rows = seq([10, { speed: mph(35) }], [10, { speed: mph(35), ...handled }], [10, { speed: mph(35) }]);
    expect(drive(createPhoneUseDetector(counterIds()), rows, undefined, ctx({ callActive: true })).all).toEqual([]);
    expect(drive(createPhoneUseDetector(counterIds()), rows, undefined, ctx({ warmupEndsAt: T0 + 30_000 })).all).toEqual([]);
    const poor = seq([10, { speed: mph(35) }], [10, { speed: mph(35), hAcc: 40, ...handled }], [10, { speed: mph(35) }]);
    expect(drive(createPhoneUseDetector(counterIds()), poor).all).toEqual([]);
  });

  test('a navigation app opened with the navigation button is not phone use', () => {
    const rows = seq([10, { speed: mph(35) }], [120, { speed: mph(35), ...navigation }], [10, { speed: mph(35) }]);
    expect(drive(createPhoneUseDetector(counterIds()), rows).all).toEqual([]);
  });

  test('a pothole under navigation is not a pickup: 2-row jolts with 2 quiet rows between them never reach 3', () => {
    const nav = { speed: mph(35), ...navigation };
    const pothole = { ...nav, handlingScore: 0.7, gravityStability: 0.6 };
    const rows = seq([10, nav], [2, pothole], [2, nav], [2, pothole], [3, nav], [2, pothole], [10, nav]);
    expect(drive(createPhoneUseDetector(counterIds()), rows).all).toEqual([]);
  });

  test('handling the phone over a navigation app opened with the button is still a pickup', () => {
    const nav = { speed: mph(35), ...navigation };
    const rows = seq([10, nav], [8, { ...nav, ...handled }], [10, nav]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'phone_pickup', durationS: 8 });
    expect(e.measured.mounted).toBe(false);
  });

  test('a phone held still after the lift adds no handling time: one 4-s pickup, no phone_handling', () => {
    const nav = { speed: mph(35), ...navigation };
    const held = { ...nav, handlingScore: 0.3, gravityStability: 0.8 };
    const rows = seq([10, nav], [4, { ...nav, ...handled }], [40, held], [10, nav]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'phone_pickup', durationS: 4 });
  });

  test('open() exposes the episode for the alerts; a quiet second does not close it, two do', () => {
    const det = createPhoneUseDetector(counterIds());
    const rows = seq([10, { speed: mph(35) }], [4, { speed: mph(35), ...handled }], [1, { speed: mph(35) }], [3, { speed: mph(35), ...handled }], [2, { speed: mph(35) }]);
    const confirmedAt: number[] = [];
    rows.forEach((r, i) => {
      det.push(r, { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, ctx());
      if (det.open()?.confirmed) confirmedAt.push(i);
    });
    expect(confirmedAt[0]).toBe(12);
    expect(det.active()).toBe(false);
    expect(det.flush()).toEqual([]);
    expect(confirmedAt).toContain(17);
  });
});

describe('maxSpeedMph: the highest trusted GPS speed from the episode start to its last use row', () => {
  test('a pickup and its handling both carry it; an untrusted speed, the rows before the start and the quiet rows after are left out', () => {
    const rows = seq(
      [10, { speed: mph(70) }],
      [6, { speed: mph(30), ...handled }],
      [1, { speed: mph(62), speedAcc: 3, ...handled }],
      [6, { speed: mph(48.04), ...handled }],
      [6, { speed: mph(40), ...handled }],
      [1, { speed: mph(80) }],
      [10, { speed: mph(30) }]
    );
    const { all } = drive(createPhoneUseDetector(counterIds()), rows);
    expect(all.map((e) => e.type)).toEqual(['phone_pickup', 'phone_handling']);
    expect(all[0]!.measured).toEqual({ mounted: false, speedMph: 30, maxSpeedMph: 48 });
    expect(all[1]!.measured).toEqual({ mounted: false, maxSpeedMph: 48 });
  });

  test('no trusted speed at all: no maxSpeedMph', () => {
    const rows = seq([10, { speed: mph(35) }], [8, { speed: mph(35), speedAcc: 3, ...handled }], [10, { speed: mph(35), speedAcc: 3 }]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e.measured.maxSpeedMph).toBeUndefined();
  });

  test('a switch charged from its first chargeable row finds the speeds of the run before it counted', () => {
    const away = { appForeground: false, screenOn: true, locked: false } as const;
    const front = { appForeground: true, screenOn: true, locked: false } as const;
    const rows = seq([10, { speed: mph(30), ...front }], [1, { speed: mph(55), ...away }], [3, { speed: mph(30), ...away }], [10, { speed: mph(30), ...front }]);
    const e = only(drive(createPhoneUseDetector(counterIds()), rows).all);
    expect(e).toMatchObject({ type: 'phone_pickup', startedAt: T0 + 10_000 });
    expect(e.measured.maxSpeedMph).toBe(55);
  });

  test('open() tells the alerts the pickup speed, stopped-in-traffic and the highest speed so far', () => {
    const det = createPhoneUseDetector(counterIds());
    const rows = seq([10, { speed: mph(35) }], [2, { speed: mph(35), ...handled }], [1, { speed: mph(52), ...handled }]);
    for (const r of rows) det.push(r, { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, ctx());
    expect(det.open()).toMatchObject({ confirmed: true, stoppedInTraffic: false, speedMph: 52, maxSpeedMph: 52 });
    const stopped = createPhoneUseDetector(counterIds());
    const still = seq([10, { speed: mph(35) }], [3, { speed: 0 }], [3, { speed: 0, ...handled }]);
    for (const r of still) stopped.push(r, { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, ctx());
    expect(stopped.open()).toMatchObject({ confirmed: true, stoppedInTraffic: true, speedMph: 0, maxSpeedMph: 0 });
  });
});
