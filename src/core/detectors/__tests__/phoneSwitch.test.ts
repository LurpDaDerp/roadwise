// Screen switches (product spec v3 "Event detection · Screen switches"; design §3, §12.1): every
// rule of `phoneSwitch.ts` and the switch half of `phoneUse.ts`, on Android and iPhone.
import { createPhoneUseDetector } from '@/core/detectors/phoneUse';
import {
  ageS,
  BURST_WINDOW_S,
  CALL_AFTER_MAX_S,
  CALL_FRONT_SPENT_ROWS,
  clampLockDelay,
  lockCutMs,
  SWITCH_MIN_S_ANDROID,
  SWITCH_MIN_S_IOS,
} from '@/core/detectors/phoneSwitch';
import type { DetectedEvent, DetectorContext, FeatureRow } from '@/core/engine/types';

import { counterIds, ctx, drive, limit, mph, seq, T0 } from '@/core/detectors/__fixtures__/rows';

const at = (i: number): number => T0 + i * 1000;
const v35 = { speed: mph(35) };
/** RoadWise in front, the phone unlocked with its screen on. */
const front = { ...v35, appForeground: true, screenOn: true, locked: false } as const;
/** Another app in front of an unlocked phone (Android: screen on; iPhone: not reported locked). */
const away = { ...v35, appForeground: false, screenOn: true, locked: false } as const;
/** iPhone: the lock report (protected data gone). */
const locked = { ...v35, appForeground: false, screenOn: false, locked: true } as const;
const handled = { handlingScore: 0.9, gravityStability: 0.6, orientationDelta: 0.2 };
/** Handling on a mounted, stable phone (a pickup that stays `mounted`). */
const tapped = { handlingScore: 0.9, gravityStability: 0.95, orientationDelta: 0.05 };

const ANDROID = ctx();
const IOS = ctx({ switchSignal: 'lagged', platform: 'ios', lockDelayMs: null });
const UNPROVEN = ctx({ switchSignal: 'unproven', platform: 'ios', lockDelayMs: null });

const run = (rows: FeatureRow[], c: DetectorContext = ANDROID): DetectedEvent[] => drive(createPhoneUseDetector(counterIds()), rows, limit(mph(35)), c).all;
const pickups = (events: DetectedEvent[]) => events.filter((e) => e.type === 'phone_pickup');
const handlingOf = (events: DetectedEvent[]) => events.filter((e) => e.type === 'phone_handling');

/** Push rows one by one, recording for each row whether a confirmed episode was open and whether it was unsafe. */
function trace(rows: FeatureRow[], c: DetectorContext) {
  const det = createPhoneUseDetector(counterIds());
  const confirmed: boolean[] = [];
  const active: boolean[] = [];
  const events: DetectedEvent[] = [];
  for (const r of rows) {
    events.push(...det.push(r, limit(mph(35)), c));
    confirmed.push(det.open()?.confirmed === true);
    active.push(det.active());
  }
  events.push(...det.flush());
  return { det, confirmed, active, events };
}

describe('the constants and their derived values', () => {
  test('ages, the lock cut and its clamp', () => {
    expect(ageS(T0, T0)).toBe(1);
    expect(ageS(T0 + 14_000, T0)).toBe(15);
    expect(clampLockDelay(null)).toBe(10_000);
    expect(clampLockDelay(9_000)).toBe(10_000);
    expect(clampLockDelay(12_345)).toBe(12_345);
    expect(clampLockDelay(40_000)).toBe(15_000);
    expect(lockCutMs(null)).toBe(11_000);
    expect(lockCutMs(13_000)).toBe(14_000);
    expect([SWITCH_MIN_S_ANDROID, SWITCH_MIN_S_IOS, CALL_AFTER_MAX_S, CALL_FRONT_SPENT_ROWS, BURST_WINDOW_S]).toEqual([3, 15, 60, 10, 120]);
  });
});

describe('Android (switchSignal reliable)', () => {
  test('1. 120 s in another app: one pickup from the first away row, never mounted, and 7 severe handling units', () => {
    const e = run(seq([10, front], [120, away], [10, front]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 120, measured: { mounted: false, speedMph: 35 } })]);
    expect(handlingOf(e)).toEqual([expect.objectContaining({ tier: 'severe', units: 7, durationS: 105 })]);
  });

  test('2. 2 s away is nothing; 3 s is a pickup of 3 s', () => {
    expect(run(seq([10, front], [2, away], [10, front]))).toEqual([]);
    expect(pickups(run(seq([10, front], [3, away], [10, front])))).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 3 })]);
  });

  test('3. the navigation button exemption: 300 s away is nothing, and motion still counts inside it', () => {
    const nav = { ...away, exempt: 'nav' } as const;
    expect(run(seq([10, front], [300, nav], [10, front]))).toEqual([]);
    const e = run(seq([10, front], [100, nav], [8, { ...nav, ...handled }], [100, nav], [10, front]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(110), durationS: 8 })]);
  });

  test('4. locked or screen off is never a switch', () => {
    expect(run(seq([10, front], [60, { ...away, screenOn: false }], [10, front]))).toEqual([]);
    expect(run(seq([10, front], [60, { ...away, locked: true }], [10, front]))).toEqual([]);
    expect(run(seq([10, front], [60, { ...away, locked: true, screenOn: false }], [10, front]))).toEqual([]);
  });

  describe('5. a call', () => {
    test("the dialer in front through a call is the call's, up to 60 s after it; then it counts", () => {
      const rows = seq([10, front], [60, { ...away, call: 'live' }], [40, away], [30, away], [5, front]);
      // the call's last row is row 69: excused through row 129 (60 s), counted from row 130
      expect(pickups(run(rows))).toEqual([expect.objectContaining({ startedAt: at(130), durationS: 10 })]);
      expect(run(seq([10, front], [60, { ...away, call: 'live' }], [55, away], [5, front]))).toEqual([]);
    });

    test('the screen going off ends the excuse; a later departure after the tail counts', () => {
      expect(run(seq([10, front], [60, { ...away, call: 'live' }], [30, away], [40, { ...away, screenOn: false }], [5, front]))).toEqual([]);
    });

    test('after 10 rows in front during the connected call, leaving again in it counts; after 9 it does not', () => {
      const ten = seq([10, front], [10, { ...front, call: 'live' }], [10, { ...away, call: 'live' }], [5, { ...front, call: 'live' }]);
      expect(pickups(run(ten))).toEqual([expect.objectContaining({ startedAt: at(20), durationS: 10 })]);
      const nine = seq([10, front], [9, { ...front, call: 'live' }], [10, { ...away, call: 'live' }], [5, { ...front, call: 'live' }]);
      expect(run(nine)).toEqual([]);
    });

    test('rows in front while it rings never spend the excuse', () => {
      expect(run(seq([10, front], [20, { ...front, call: 'ring' }], [30, { ...away, call: 'live' }], [5, front]))).toEqual([]);
    });

    test('a switch already counting when a call starts is charged up to the call', () => {
      const e = run(seq([10, front], [10, away], [30, { ...away, call: 'live' }], [5, front]));
      expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 10 })]);
    });

    test('a 3-minute call with the dialer in front the whole time is nothing (the stated bypass)', () => {
      expect(run(seq([10, front], [180, { ...away, call: 'live' }], [5, front]))).toEqual([]);
    });

    test("a departure 4 s after a call's last row is still the call's; 6 s after, it counts", () => {
      const four = seq([10, front], [5, { ...front, call: 'live' }], [4, front], [20, away], [5, front]);
      expect(run(four)).toEqual([]);
      const six = seq([10, front], [5, { ...front, call: 'live' }], [6, front], [20, away], [5, front]);
      expect(pickups(run(six))).toEqual([expect.objectContaining({ startedAt: at(21), durationS: 20 })]);
    });
  });

  test('6. away from the drive start: the warm-up rows never start a run; it counts from the 30-s mark', () => {
    const e = run(seq([60, away], [5, front]), ctx({ warmupEndsAt: T0 + 30_000 }));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(30), durationS: 30 })]);
  });

  test('7. away while parked before the car ever moved: charged from the first row above 5 mph', () => {
    const e = run(seq([60, { ...away, speed: 0 }], [30, away], [5, front]));
    const p = pickups(e);
    expect(p).toEqual([expect.objectContaining({ startedAt: at(60), durationS: 30 })]);
    expect(p[0]?.stoppedInTraffic).toBeUndefined();
  });

  test('8. away while stopped after driving: stopped in traffic', () => {
    const e = run(seq([10, front], [10, { ...away, speed: 0 }], [5, { ...front, speed: 0 }]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), stoppedInTraffic: true, durationS: 10 })]);
  });

  test('9. once counted, a GPS gap neither splits nor ends it', () => {
    const e = run(seq([10, front], [5, away], [10, { ...away, gnssValid: false, hAcc: 9999, speed: -1 }], [20, away], [5, front]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 35 })]);
  });

  test('10. the fix it may start on: within 50 m; a worse one waits for a good row; none never starts', () => {
    expect(pickups(run(seq([10, front], [10, { ...away, hAcc: 35 }], [5, front])))).toEqual([expect.objectContaining({ startedAt: at(10) })]);
    const later = run(seq([10, front], [10, { ...away, hAcc: 60 }], [10, { ...away, hAcc: 10 }], [5, front]));
    expect(pickups(later)).toEqual([expect.objectContaining({ startedAt: at(20), durationS: 10 })]);
    expect(run(seq([10, front], [30, { ...away, gnssValid: false, hAcc: 9999, speed: -1 }], [5, front]))).toEqual([]);
  });

  test('11. motion handling then a switch: one episode, never mounted, to the last away row', () => {
    const e = run(seq([10, front], [4, { ...front, ...tapped }], [10, away], [5, front]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 14, measured: { mounted: false, speedMph: 35 } })]);
  });

  test('12. a parking-lot motion episode, then a switch while moving: one pickup, from the switch', () => {
    const e = run(seq([5, { ...front, speed: 0 }], [10, { ...front, speed: 0, ...handled }], [10, { ...away, ...handled }], [5, front]));
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(15), durationS: 10 })]);
  });

  test('13. a 1-s return keeps one episode; a 2-s return closes it and the next switch is a second pickup', () => {
    expect(pickups(run(seq([10, front], [5, away], [1, front], [5, away], [5, front])))).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 11 })]);
    expect(pickups(run(seq([10, front], [5, away], [2, front], [5, away], [5, front])))).toHaveLength(2);
  });

  test("14. switchSignal none: nothing, and short switches never make a burst", () => {
    const NONE = ctx({ switchSignal: 'none' });
    expect(run(seq([10, front], [120, away], [10, front]), NONE)).toEqual([]);
    expect(run(seq([10, front], [2, away], [3, front], [2, away], [3, front], [2, away], [5, front]), NONE)).toEqual([]);
  });

  describe('15. bursts', () => {
    test('three 2-s switches ending back in RoadWise within 2 min: one pickup at the third return, no handling', () => {
      const rows = seq([10, front], [2, away], [3, front], [2, away], [3, front], [2, away], [5, front]);
      const t = trace(rows, ANDROID);
      expect(pickups(t.events)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 12 })]);
      expect(handlingOf(t.events)).toEqual([]);
      // confirmed first on the third return (row 22), not before
      expect(t.confirmed.indexOf(true)).toBe(22);
    });

    test('the stop speed of the last run decides stopped in traffic; a burst is clamped to one pickup of 15 s at most', () => {
      const rows = seq([10, front], [2, away], [20, front], [2, away], [20, front], [2, { ...away, speed: 0 }], [5, { ...front, speed: 0 }]);
      const p = pickups(run(rows));
      expect(p).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 15, stoppedInTraffic: true })]);
    });

    test('1-s switches, three spread over 150 s, or short switches parked before moving: nothing', () => {
      expect(run(seq([10, front], [1, away], [3, front], [1, away], [3, front], [1, away], [5, front]))).toEqual([]);
      expect(run(seq([10, front], [2, away], [70, front], [2, away], [70, front], [2, away], [5, front]))).toEqual([]);
      const parked = seq([2, { ...away, speed: 0 }], [3, { ...front, speed: 0 }], [2, { ...away, speed: 0 }], [3, { ...front, speed: 0 }], [2, { ...away, speed: 0 }], [5, { ...front, speed: 0 }]);
      expect(run(parked)).toEqual([]);
    });

    test('a long switch that joins the burst right after it adds its own time (the clamp covers only the short ones)', () => {
      const rows = seq([10, front], [2, away], [3, front], [2, away], [3, front], [2, away], [1, front], [40, away], [5, front]);
      const e = run(rows);
      // the burst rows 10–21 count 12 s; the joined switch, rows 23–62, adds 41 s past row 21
      expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 53 })]);
      expect(handlingOf(e)).toEqual([expect.objectContaining({ durationS: 38, units: 3 })]);
    });

    test('six short switches within 100 s: two pickups', () => {
      const unit = [[2, away], [3, front]] as const;
      const rows = seq([10, front], ...unit, ...unit, ...unit, [5, front], ...unit, ...unit, ...unit, [5, front]);
      expect(pickups(run(rows))).toHaveLength(2);
    });
  });

  test('16. a one-row dip, repeated: nothing', () => {
    const dips = seq([10, front], ...Array.from({ length: 10 }, () => [[1, away], [2, front]] as const).flat());
    expect(run(dips)).toEqual([]);
  });

  test('Android never proves anything: lockProof stays null', () => {
    expect(trace(seq([10, front], [10, away], [20, locked], [5, front]), ANDROID).det.lockProof()).toBeNull();
  });
});

describe('iPhone (switchSignal lagged, lock delay unmeasured: the cut is 11 s)', () => {
  test('17. a lock with RoadWise in front: nothing, and it proves the phone (9 s measured, clamped to 10 s for the cut)', () => {
    const t = trace(seq([10, front], [10, away], [60, locked]), IOS);
    expect(t.events).toEqual([]);
    expect(t.confirmed.some(Boolean)).toBe(false);
    expect(t.det.lockProof()).toEqual({ delayMs: 9_000 });
  });

  test('18. 40 s in another app: one pickup from the first away row, counted at age 15', () => {
    const t = trace(seq([10, front], [40, away], [10, front]), IOS);
    expect(pickups(t.events)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 40 })]);
    expect(t.confirmed.indexOf(true)).toBe(10 + 14);
  });

  test('19. 14 s away is nothing on its own', () => {
    expect(run(seq([10, front], [14, away], [10, front]), IOS)).toEqual([]);
  });

  test('20. a switch, a lock pressed 20 s in, its report 10 s later: a pickup of 20 s', () => {
    const e = run(seq([10, front], [30, away], [30, locked]), IOS);
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 20 })]);
  });

  describe('21. slow lock reports from RoadWise in front (the report reaches the row at run age a; kept = a − 11)', () => {
    const lockAt = (a: number, c: DetectorContext = IOS) => trace(seq([10, front], [a - 1, away], [30, locked]), c);
    test('a = 15 (14 s late): never counted, nothing', () => {
      const t = lockAt(15);
      expect(t.confirmed.some(Boolean)).toBe(false);
      expect(t.events).toEqual([]);
    });
    test.each([16, 17, 19, 25])('a = %i: counted at age 15, then dropped as a lock reported late', (a) => {
      const t = lockAt(a);
      expect(t.confirmed[10 + 14]).toBe(true);
      expect(t.events).toEqual([]);
    });
    test('a = 26 (kept 15): a pickup of 15 s, the boundary', () => {
      expect(pickups(lockAt(26).events)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 15 })]);
    });
    test('22. with a measured 13-s delay (cut 14 s): a = 28 is dropped, a = 29 kept as 15 s', () => {
      const c = ctx({ switchSignal: 'lagged', platform: 'ios', lockDelayMs: 13_000 });
      expect(lockAt(28, c).events).toEqual([]);
      expect(pickups(lockAt(29, c).events)).toEqual([expect.objectContaining({ durationS: 15 })]);
    });
  });

  test('23. a motion pickup, then a lock with RoadWise in front: the departure is held, then nothing of it is applied', () => {
    const rows = seq([10, front], [3, { ...front, ...tapped }], [10, away], [30, locked]);
    const t = trace(rows, IOS);
    expect(pickups(t.events)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 3, measured: { mounted: true, speedMph: 35 } })]);
    expect(handlingOf(t.events)).toEqual([]);
    // the held rows are not unsafe
    expect(t.active.slice(13, 23)).toEqual(Array(10).fill(false));
  });

  test('24. a motion pickup, then a real switch of 30 s: held to age 15, then one episode, never mounted', () => {
    const e = run(seq([10, front], [3, { ...front, ...tapped }], [30, away], [10, front]), IOS);
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 33, measured: { mounted: false, speedMph: 35 } })]);
  });

  test('25. a switch that joined a motion pickup and counted, then a lock 5 s later: its share is dropped and mounted restored', () => {
    const e = run(seq([10, front], [3, { ...front, ...tapped }], [19, away], [30, locked]), IOS);
    expect(pickups(e)).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 3, measured: { mounted: true, speedMph: 35 } })]);
  });

  test('26. unproven: no switch counts until a lock is reported in time; after that they do', () => {
    const before = seq([10, front], [40, away], [10, front]);
    expect(run(before, UNPROVEN)).toEqual([]);
    const proved = seq([10, front], [40, away], [10, front], [10, away], [5, locked], [10, front], [40, away], [10, front]);
    const t = trace(proved, UNPROVEN);
    expect(t.det.lockProof()).toEqual({ delayMs: 9_000 });
    expect(pickups(t.events)).toEqual([expect.objectContaining({ startedAt: at(85), durationS: 40 })]);
  });

  test('27. unproven, and the only lock report comes 60 s after leaving (a delayed passcode): no proof, nothing counts', () => {
    const t = trace(seq([10, front], [60, away], [10, locked], [10, front], [40, away], [10, front]), UNPROVEN);
    expect(t.det.lockProof()).toBeNull();
    expect(t.events).toEqual([]);
  });

  test("28. no false proof after a call: RoadWise left during the call, the lock report came 110 s later", () => {
    const rows = seq([10, front], [51, { ...away, call: 'live' }], [59, away], [10, locked], [10, front], [40, away], [10, front]);
    const t = trace(rows, UNPROVEN);
    expect(t.det.lockProof()).toBeNull();
    expect(t.events).toEqual([]);
  });

  test('29. no false proof from the warm-up: RoadWise left at the start, the lock report came 30 s later', () => {
    const t = trace(seq([1, front], [30, away], [10, locked]), ctx({ switchSignal: 'unproven', platform: 'ios', lockDelayMs: null, warmupEndsAt: T0 + 30_000 }));
    expect(t.det.lockProof()).toBeNull();
    expect(t.events).toEqual([]);
  });

  test('30. iPhone motion during a call is not counted, live or rebuilt; Android motion is', () => {
    const rows = seq([10, front], [10, { ...front, ...handled, call: 'live' }], [10, front]);
    expect(run(rows, IOS)).toEqual([]);
    expect(run(rows, { ...IOS, callActive: true })).toEqual([]);
    expect(pickups(run(rows, ANDROID))).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 10 })]);
  });

  describe('31. bursts: a short switch counts toward one only when it outlasted the lock cut (a lock undone before its report never does)', () => {
    const three = (n: number) => seq([10, front], [n, away], [10, front], [n, away], [10, front], [n, away], [5, front]);
    test('three 13-s switches ending in RoadWise within 2 min are one pickup (span 12 s > the 11-s cut)', () => {
      expect(pickups(run(three(13), IOS))).toEqual([expect.objectContaining({ startedAt: at(10), durationS: 15, measured: { mounted: false, speedMph: 35 } })]);
    });
    test.each([2, 5, 6, 10, 12])('three %i-s runs ending in RoadWise (a lock and an unlock before iOS reports it reads the same): nothing', (n) => {
      expect(run(three(n), IOS)).toEqual([]);
    });
    test('three locks undone within 5 s at a 40-s interval: nothing (iPhone), nothing (Android)', () => {
      const rows = seq([40, front], [5, away], [20, front], [5, away], [20, front], [5, away], [20, front]);
      expect(run(rows, IOS)).toEqual([]);
      const androidLocks = seq([40, front], [5, { ...away, screenOn: false, locked: true }], [20, front], [5, { ...away, screenOn: false, locked: true }], [20, front], [5, { ...away, screenOn: false, locked: true }], [20, front]);
      expect(run(androidLocks, ANDROID)).toEqual([]);
    });
    test('a measured 11-s delay (cut 12 s) needs 14 rows; from 12 s (cut 13 s) no run under 15 s outlasts the cut', () => {
      const delay = (ms: number) => ctx({ switchSignal: 'lagged', platform: 'ios', lockDelayMs: ms });
      expect(run(three(13), delay(11_000))).toEqual([]);
      expect(pickups(run(three(14), delay(11_000)))).toHaveLength(1);
      expect(run(three(14), delay(12_000))).toEqual([]);
      expect(run(three(14), delay(13_000))).toEqual([]);
    });
    test('three ending in lock reports are nothing', () => {
      const locks = seq([10, front], [13, away], [3, locked], [10, front], [13, away], [3, locked], [10, front], [13, away], [3, locked], [5, front]);
      expect(run(locks, IOS)).toEqual([]);
    });
  });

  describe('32. an unlock outside RoadWise after a lock report (a Face ID glance at the woken lock screen reads as away): it counts only from age 15 + the 11-s cut', () => {
    /** RoadWise left (the lock press), the lock reported, then `n` rows unlocked outside RoadWise. */
    type Seg = readonly [number, Partial<FeatureRow>];
    const afterLock = (n: number, then: Seg = [10, front]) => seq([10, front], [10, away], [20, locked], [n, away], then);
    test('a glance of 8 s and the 10-s grace, then the lock report again: never confirmed (no alert), nothing', () => {
      const t = trace(afterLock(18, [20, locked]), IOS);
      expect(t.confirmed.some(Boolean)).toBe(false);
      expect(t.events).toEqual([]);
    });
    test('a glance of 15 s and the grace (25 rows), then the report: never confirmed, nothing', () => {
      const t = trace(afterLock(25, [20, locked]), IOS);
      expect(t.confirmed.some(Boolean)).toBe(false);
      expect(t.events).toEqual([]);
    });
    test('unlocked into another app for 40 s: one pickup from its first row, confirmed at age 26', () => {
      const t = trace(afterLock(40), IOS);
      expect(pickups(t.events)).toEqual([expect.objectContaining({ startedAt: at(40), durationS: 40, measured: { mounted: false, speedMph: 35 } })]);
      expect(t.confirmed.indexOf(true)).toBe(40 + 25);
    });
    test('the boundary: 25 rows then RoadWise is nothing, 26 is a pickup of 26 s', () => {
      expect(run(afterLock(25), IOS)).toEqual([]);
      expect(pickups(run(afterLock(26), IOS))).toEqual([expect.objectContaining({ startedAt: at(40), durationS: 26 })]);
    });
    test('a 13-s delay measured in the drive (cut 14 s): 28 rows are nothing, 29 a pickup', () => {
      // the lock press at row 10, its report at row 24: 13 s measured, which replaces the context's
      const slow = (n: number) => trace(seq([10, front], [14, away], [20, locked], [n, away], [10, front]), IOS);
      expect(slow(28).det.lockProof()).toEqual({ delayMs: 13_000 });
      expect(slow(28).events).toEqual([]);
      expect(pickups(slow(29).events)).toEqual([expect.objectContaining({ startedAt: at(44), durationS: 29 })]);
    });
    test('a run after a lock never counts toward a burst; RoadWise in front in between clears the lock', () => {
      const cycle: Seg[] = [[10, away], [3, locked], [13, away], [5, front]];
      expect(run(seq([10, front], ...cycle, ...cycle, ...cycle), IOS)).toEqual([]);
      // the same 13-s runs with RoadWise in front after each lock are a burst
      const cleared: Seg[] = [[10, away], [3, locked], [1, front], [13, away], [5, front]];
      expect(pickups(run(seq([10, front], ...cleared, ...cleared, ...cleared), IOS))).toHaveLength(1);
    });
    test('Android is unchanged: an unlock into another app counts at 3 s', () => {
      const offRows = { ...away, screenOn: false, locked: true };
      expect(pickups(run(seq([10, front], [20, offRows], [10, away], [10, front]), ANDROID))).toEqual([expect.objectContaining({ startedAt: at(30), durationS: 10 })]);
    });
  });

  test('without a passcode (none) nothing is a switch and nothing proves the phone', () => {
    const NONE = ctx({ switchSignal: 'none', platform: 'ios' });
    const t = trace(seq([10, front], [10, away], [20, locked], [10, front], [60, away], [10, front]), NONE);
    expect(t.events).toEqual([]);
    expect(t.det.lockProof()).toBeNull();
  });
});
