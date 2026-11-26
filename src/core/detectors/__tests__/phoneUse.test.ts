import { createPhoneUseDetector, heldToLook, phoneSecond, PHONE_REPEAT_IN_HAND_S } from '@/core/detectors/phoneUse';
import { angleDeg, gravityOf, phonePose } from '@/core/detectors/common';
import { counterIds, ctx, drive, gravity, heldSteady, inHand, mph, NO_LIMIT, only, RESTING, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { DetectorContext, FeatureRow, PhoneAlert } from '@/core/engine/types';

const at = (mphV: number, extra: Partial<FeatureRow> = {}): Partial<FeatureRow> => ({ speed: mph(mphV), ...extra });
/** A second of the phone in the hand at `mphV` (row `i`'s wobble). */
const hand =
  (mphV: number, extra: Partial<FeatureRow> = {}) =>
  (i: number): Partial<FeatureRow> => ({ speed: mph(mphV), ...inHand(i), ...extra });
/** The IMU-absent encoding: every IMU field 0 (a native row then carries no gravity direction either). */
const NO_IMU = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };
/**
 * The first 11 rows: a first reading and the 10 still seconds after it that give the detector its
 * resting tilt (`RESTING`, upright in a cup holder). Row `R + k` is the `k`th row after them.
 */
const R = 11;
const REST = [R, at(35)] as const;
/** The row clock of row `R + k`. */
const after = (k: number): number => T0 + (R + k) * 1000;
/** A shake that leaves the tilt where it is (a pothole, a rattle): the gravity swinging within the second. */
const jolt = { handlingScore: 1, gravityStability: 0.2, orientationDelta: 0.6, yawRateMax: 1 };

const run = (rows: FeatureRow[], c: DetectorContext = ctx()) => drive(createPhoneUseDetector(counterIds()), rows, NO_LIMIT, c);
/** Rows at the given whole seconds, the `k`th of them `over(k)` (a phone in the hand by default, wobbling row to row). */
const rowsAt = (secs: number[], over: (k: number) => Partial<FeatureRow> = (k) => hand(35)(k)): FeatureRow[] =>
  secs.map((s, k) => row({ ...over(k), ts: T0 + s * 1000 }));
const restingAt = (secs: number[]): FeatureRow[] => rowsAt(secs, () => at(35));
/** Rows 0 to 10 at rest, by their seconds. */
const restRows = (): FeatureRow[] => restingAt([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/** Each row's alerts, by row index. */
function alertsOf(rows: FeatureRow[], c: DetectorContext = ctx()): { i: number; alert: PhoneAlert }[] {
  const det = createPhoneUseDetector(counterIds());
  const out: { i: number; alert: PhoneAlert }[] = [];
  rows.forEach((r, i) => {
    det.push(r, NO_LIMIT, c);
    for (const alert of det.alerts()) out.push({ i, alert });
  });
  return out;
}

describe('the geometry', () => {
  test('gravityOf: the row gravity direction as a unit vector, or null with none', () => {
    expect(gravityOf(row({ gx: 0, gy: 0, gz: -2 }))).toEqual([0, 0, -1]);
    expect(gravityOf(row(RESTING))).not.toBeNull();
    const { gx: _x, gy: _y, gz: _z, ...bare } = row();
    expect(gravityOf(bare)).toBeNull();
    expect(gravityOf(row({ gx: 0, gy: 0, gz: 0 }))).toBeNull();
    expect(gravityOf(row({ gx: 0.1, gy: 0.1, gz: 0.1 }))).toBeNull();
    expect(gravityOf(row({ gx: Number.NaN }))).toBeNull();
  });

  test('phonePose: the tilt up from lying flat and the roll of the top from straight up', () => {
    const pose = (t: number, r = 0) => phonePose(gravityOf(row(gravity(t, r)))!);
    expect(pose(0).tilt).toBeCloseTo(0, 0);
    expect(pose(45).tilt).toBeCloseTo(45, 0);
    expect(pose(90).tilt).toBeCloseTo(90, 9);
    expect(pose(90).roll).toBe(0);
    expect(pose(180).tilt).toBeCloseTo(180, 0);
    expect(pose(60, 90).roll).toBeCloseTo(90, 0);
    expect(pose(60, -90).roll).toBeCloseTo(90, 0);
    expect(pose(60, 180).roll).toBeCloseTo(180, 0);
  });

  test('held to look at: the screen tilted up 15° to 80°, the top no more than 120° from straight up', () => {
    const look = (t: number, r = 0) => heldToLook(gravityOf(row(gravity(t, r)))!);
    expect([look(45), look(16), look(79), look(45, 90), look(45, -119)]).toEqual([true, true, true, true, true]);
    // Flat on a seat or a console, upright in a cup holder or a mount, face down, upside down.
    expect([look(5), look(14), look(81), look(90), look(150), look(45, 125), look(45, 180)]).toEqual([false, false, false, false, false, false, false]);
  });

  test('a second is use (away and moving), held (away and still) or quiet; never on a call; never with the screen off on Android', () => {
    const rest = gravityOf(row(RESTING))!;
    const hand = row({ ...gravity(45), screenOn: false });
    const g = gravityOf(hand)!;
    expect(angleDeg(g, rest)).toBeCloseTo(40, 0);
    expect(phoneSecond(hand, g, true, rest, { platform: 'ios' })).toBe('use');
    expect(phoneSecond(hand, g, false, rest, { platform: 'ios' })).toBe('held');
    expect(phoneSecond(hand, g, true, null, { platform: 'ios' })).toBe('quiet');
    expect(phoneSecond({ ...hand, call: 'live' }, g, true, rest, { platform: 'ios' })).toBe('quiet');
    expect(phoneSecond({ ...hand, call: 'ring' }, g, true, rest, { platform: 'android' })).toBe('quiet');
    expect(phoneSecond(hand, g, true, rest, { platform: 'android' })).toBe('quiet');
    expect(phoneSecond({ ...hand, screenOn: true }, g, true, rest, { platform: 'android' })).toBe('use');
    // 29° from the resting tilt is not away; 31° is.
    const near = row(gravity(85 - 29));
    expect(phoneSecond(near, gravityOf(near)!, true, rest, { platform: 'ios' })).toBe('quiet');
    const far = row(gravity(85 - 31));
    expect(phoneSecond(far, gravityOf(far)!, true, rest, { platform: 'ios' })).toBe('use');
  });
});

describe('phone pickups (phone plan P1)', () => {
  test('8 s in the hand at 35 mph is one moderate pickup of 8 s, told once it is put down', () => {
    const rows = seq(REST, [8, hand(35)], [20, at(35)]);
    const { pushed, all } = run(rows);
    const e = only(all);
    expect(e).toMatchObject({ id: 'e1', type: 'phone_pickup', tier: 'moderate', startedAt: after(0), durationS: 8 });
    expect(e.measured).toEqual({ speedMph: 35, maxSpeedMph: 35 });
    // The last second away is R + 7; 10 s later (and 10 still seconds back in the cup holder) it was put down.
    expect(pushed.findIndex((p) => p.length > 0)).toBe(R + 18);
  });

  test('shaking is not a pickup: a phone rattling in its holder on a rough road for 2 minutes, however hard, never counts', () => {
    // The old shake score at its top every second, the gravity swinging within every third second, the tilt jittering by under a degree.
    const rattle = (i: number): Partial<FeatureRow> => ({ ...gravity(85 + (i % 3) * 0.3, (i % 2) * 0.4), ...(i % 3 === 0 ? jolt : { handlingScore: 1, gravityStability: 0.6 }) });
    const rows = seq(REST, [120, (i) => at(35, rattle(i))], [20, at(35)]);
    expect(run(rows).all).toEqual([]);
    expect(alertsOf(rows)).toEqual([]);
    // From the first row of the drive, before any rest: nothing either.
    expect(run(seq([120, (i) => at(35, rattle(i))])).all).toEqual([]);
  });

  test('a phone that tips, untouched, into a lean it could be looked at in and then shakes on a rough road is no pickup', () => {
    const shaking = (i: number) => at(35, { ...gravity(50 + (i % 2) * 0.5), ...(i % 3 === 0 ? jolt : { handlingScore: 0.5, gravityStability: 0.7 }) });
    const rows = seq(REST, [1, at(35, { ...gravity(50), ...jolt })], [120, shaking], [20, at(35, gravity(50))]);
    expect(run(rows).all).toEqual([]);
    expect(alertsOf(rows)).toEqual([]);
  });

  test('nothing counts before the phone has first come to rest (10 still seconds) in the drive', () => {
    expect(run(seq([R - 1, at(35)], [20, hand(35)], [20, at(35)])).all).toEqual([]);
    expect(only(run(seq([R, at(35)], [20, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0) });
  });

  test('a phone moving about in a lean that is not held to look at (flat, upright, face down, upside down) is never a pickup', () => {
    const pairs = [
      [gravity(5), gravity(12)],
      [gravity(88, 30), gravity(84, 20)],
      [gravity(170), gravity(160)],
      [gravity(45, 180), gravity(45, 170)],
    ] as const;
    for (const [a, b] of pairs) {
      const rows = seq(REST, [30, (i) => at(35, i % 2 === 0 ? a : b)], [20, at(35)]);
      expect(run(rows).all).toEqual([]);
    }
  });

  test('a phone moved to a new spot it sits in held to look at (a tilted charger, a mount) is no pickup, and tells nothing', () => {
    // Two moving seconds on the way (49°, then 41°, where it stays), then it sits there for the rest of the drive.
    const rows = seq(REST, [2, hand(35)], [120, at(35, gravity(41))]);
    expect(run(rows).all).toEqual([]);
    expect(alertsOf(rows)).toEqual([]);
    // That spot is the resting tilt from then on: a later pickup from it counts from there.
    const landscape = (i: number) => at(35, gravity(i % 2 === 0 ? 41 : 49, 90));
    const later = seq(REST, [2, hand(35)], [30, at(35, gravity(41))], [8, landscape], [20, at(35, gravity(41))]);
    expect(only(run(later).all)).toMatchObject({ startedAt: after(32), durationS: 8 });
  });

  test('jolts in that spot never make it a pickup: one pothole, a bumpy road for 3 minutes, on Android with the screen on too', () => {
    const sitting = at(35, gravity(41));
    const bumped = at(35, { ...gravity(41), ...jolt });
    const one = seq(REST, [2, hand(35)], [2, sitting], [1, bumped], [60, sitting]);
    expect(run(one).all).toEqual([]);
    expect(alertsOf(one)).toEqual([]);
    const bumpy = seq(REST, [2, hand(35)], [180, (i) => (i % 4 === 0 ? bumped : sitting)], [30, sitting]);
    expect(run(bumpy).all).toEqual([]);
    expect(alertsOf(bumpy)).toEqual([]);
    expect(run(bumpy.map((r) => ({ ...r, screenOn: true })), ctx({ platform: 'android' })).all).toEqual([]);
  });

  test('a real pickup put down in a spot it could be looked at in, on a bumpy road: its time in hand ends at the put-down', () => {
    const lean = at(35, { ...gravity(50), handlingScore: 0, gravityStability: 0.99, orientationDelta: 0.01 });
    const bump = at(35, { ...gravity(50), ...jolt });
    const rows = seq(REST, [5, hand(35)], [120, (i) => (i % 5 === 0 ? bump : lean)], [30, lean]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: after(0), durationS: 5 });
  });

  test('moving the phone by hand for 3 use seconds at driving speed counts, even into a new spot: a pickup of the time it took', () => {
    const rows = seq(REST, [3, hand(35)], [120, at(35, gravity(49))]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: after(0), durationS: 3 });
    expect(alertsOf(rows)).toEqual([{ i: R + 2, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
  });

  test('a tap of under 3 use seconds is never a pickup', () => {
    expect(run(seq(REST, [2, hand(35)], [20, at(35)])).all).toEqual([]);
  });

  test('before it is a pickup, two quiet seconds drop it: three 1-row tilts 5 s apart never confirm', () => {
    expect(run(seq(REST, [1, hand(35)], [4, at(35)], [1, hand(35)], [4, at(35)], [1, hand(35)], [20, at(35)])).all).toEqual([]);
    // Nor 2-row tilts with 2 quiet rows between, nor single rows with a gap of 2 s or more in the rows.
    expect(run(seq(REST, [2, hand(35)], [2, at(35)], [2, hand(35)], [2, at(35)], [2, hand(35)], [20, at(35)])).all).toEqual([]);
    expect(run([...restRows(), ...rowsAt([11, 14, 17, 20]), row({ ...at(35), ts: T0 + 60_000 })]).all).toEqual([]);
  });

  test('a real pickup with a one-row dip still confirms, the dip in its time in hand', () => {
    const rows = seq(REST, [1, hand(35)], [1, at(35)], [1, hand(35)], [1, at(35)], [4, hand(35)], [20, at(35)]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: after(0), durationS: 8 });
    expect(alertsOf(rows)).toEqual([{ i: R + 4, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
    // A missing row (a 1 s gap) is a dip too.
    expect(only(run([...restRows(), ...rowsAt([11, 13, 15]), row({ ...at(35), ts: T0 + 60_000 })]).all)).toMatchObject({ durationS: 3 });
  });

  test('held steady in the hand: the steady seconds count once the phone moves again, before 10 still seconds', () => {
    // Lifted (two moving seconds), held dead still for 7 s more, then put back: told on the put-down.
    const steady = seq(REST, [1, hand(35)], [8, at(35, heldSteady)], [20, at(35)]);
    expect(only(run(steady).all)).toMatchObject({ startedAt: after(0), durationS: 9, tier: 'moderate' });
    expect(alertsOf(steady)).toEqual([{ i: R + 9, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
    // A shift in the hand mid-hold makes the seconds before it count just the same.
    const shift = seq(REST, [1, hand(35)], [5, at(35, heldSteady)], [1, hand(35)], [5, at(35, heldSteady)], [20, at(35)]);
    expect(only(run(shift).all)).toMatchObject({ durationS: 12 });
    expect(alertsOf(shift)).toEqual([{ i: R + 6, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
    // 9 still seconds and then moved: they count (an 11 s pickup); 10 read as put down (below).
    expect(only(run(seq(REST, [1, hand(35)], [10, at(35, heldSteady)], [20, at(35)])).all)).toMatchObject({ durationS: 11 });
  });

  test('held dead steady for 10 s reads as put down where the steady hold began', () => {
    // A pickup (5 s), then 10 still seconds: it closes as it stood, and moving about near that spot is no new pickup.
    expect(only(run(seq(REST, [4, hand(35)], [11, at(35, heldSteady)], [4, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0), durationS: 5 });
    // Before it was a pickup: two moving seconds and 10 still ones are nothing.
    expect(run(seq(REST, [1, hand(35)], [11, at(35, heldSteady)], [20, at(35)])).all).toEqual([]);
    // Nor does a steady hold's time ring a repeat it then loses: 14 s that count, no alert at 15.
    const long = seq(REST, [13, hand(35)], [12, at(35, heldSteady)], [20, at(35)]);
    expect(only(run(long).all)).toMatchObject({ durationS: 14, tier: 'moderate' });
    expect(alertsOf(long)).toEqual([{ i: R + 2, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
  });

  test('the put-down motion is never a second pickup: one pickup through it', () => {
    expect(only(run(seq(REST, [8, hand(35)], [3, at(35)], [2, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0), durationS: 13 });
  });

  test('a re-grab 6 s after the last use second is the same pickup, the time between included', () => {
    expect(only(run(seq(REST, [5, hand(35)], [5, at(35)], [5, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0), durationS: 15, tier: 'moderate' });
  });

  test('a re-grab 12 s after is a second pickup; 10 s after (9 s at rest) the same one, 11 s after (10 s at rest) a second', () => {
    const twelve = run(seq(REST, [5, hand(35)], [11, at(35)], [5, hand(35)], [20, at(35)])).all;
    expect(twelve.map((e) => [e.startedAt, e.durationS])).toEqual([
      [after(0), 5],
      [after(16), 5],
    ]);
    expect(run(seq(REST, [5, hand(35)], [9, at(35)], [5, hand(35)], [20, at(35)])).all).toHaveLength(1);
    expect(run(seq(REST, [5, hand(35)], [10, at(35)], [5, hand(35)], [20, at(35)])).all).toHaveLength(2);
  });

  test('a pickup at a red light put down before the car reaches 10 mph never counts', () => {
    expect(run(seq(REST, [10, at(0)], [10, hand(0)], [12, at(0)], [3, at(6)], [20, at(35)])).all).toEqual([]);
    // 5 to 9 mph (moving, below driving speed) is not driving speed either.
    expect(run(seq(REST, [10, hand(8)], [12, at(8)], [20, at(35)])).all).toEqual([]);
    // An untrusted 35 mph is not driving speed.
    expect(run(seq([R, at(0)], [10, hand(35, { speedAcc: 3 })], [12, at(0)])).all).toEqual([]);
  });

  test('picked up stopped, then driving off with it: counted from the first second away at driving speed', () => {
    const e = only(run(seq([R, at(0)], [10, hand(0)], [3, hand(9)], [6, hand(12)], [20, at(35)])).all);
    expect(e).toMatchObject({ startedAt: after(13), durationS: 6 });
    expect(e.measured).toEqual({ speedMph: 12, maxSpeedMph: 12 });
    // Held steady as the car pulls away: the start counts once the phone moves again.
    const steady = only(run(seq([R, at(0)], [4, hand(0)], [6, at(0, heldSteady)], [3, at(12, heldSteady)], [2, hand(20)], [20, at(35)])).all);
    expect(steady).toMatchObject({ startedAt: after(10), durationS: 5 });
  });

  test('time in hand at a red light adds nothing, nor after parking', () => {
    expect(only(run(seq(REST, [5, hand(35)], [20, hand(0)], [5, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0), durationS: 10 });
    expect(only(run(seq(REST, [5, hand(35)], [30, hand(0)])).all)).toMatchObject({ durationS: 5 });
    // 4 mph (under 5) is a stop too; 5 mph counts.
    expect(only(run(seq(REST, [5, hand(35)], [3, hand(4)], [3, hand(5)], [20, at(35)])).all)).toMatchObject({ durationS: 8 });
  });

  test('a GPS gap: seconds in the hand with no fix continue the pickup and add nothing to its time in hand', () => {
    const gap = { gnssValid: false, speed: -1 };
    expect(only(run(seq(REST, [5, hand(35)], [12, hand(35, gap)], [5, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: after(0), durationS: 10 });
    // A gap with no rows at all: time decides, so 30 s missing put it down and 8 s did not. The first
    // reading after a gap of more than 2 s has no step to judge, so the second pickup opens a second later.
    const twice = run([...restRows(), ...rowsAt([11, 12, 13, 14]), ...rowsAt([45, 46, 47, 48]), row({ ...at(35), ts: T0 + 90_000 })]).all;
    expect(twice.map((e) => [e.startedAt - T0, e.durationS])).toEqual([
      [11_000, 4],
      [46_000, 3],
    ]);
    expect(only(run([...restRows(), ...rowsAt([11, 12, 13, 14]), ...rowsAt([22, 23, 24]), row({ ...at(35), ts: T0 + 90_000 })]).all)).toMatchObject({ durationS: 7 });
  });

  test('a gap in the rows breaks a still run: still seconds either side of it never make a rest together', () => {
    // 4 still seconds, a 10 s gap, 4 more: no rest yet, so a pickup right after is nothing.
    const rows = [...restingAt([0, 1, 2, 3, 4]), ...restingAt([15, 16, 17, 18, 19]), ...rowsAt([20, 21, 22, 23, 24]), ...restingAt([25, 26, 27])];
    expect(run(rows).all).toEqual([]);
  });

  test('a second with the IMU absent changes nothing: the next reading is judged against the last one', () => {
    // Placed in a charger, a second with no reading while it sits there, then left: no pickup.
    const sitting = at(35, gravity(41));
    expect(run(seq(REST, [2, hand(35)], [4, sitting], [1, at(35, NO_IMU)], [60, sitting])).all).toEqual([]);
    // A steady hold with a second of no reading in it still reads as put down after 10 still seconds.
    expect(run(seq(REST, [1, hand(35)], [4, at(35, heldSteady)], [1, at(35, NO_IMU)], [12, at(35, heldSteady)], [20, at(35)])).all).toEqual([]);
    // And the resting tilt forms across one.
    expect(only(run(seq([5, at(35)], [1, at(35, NO_IMU)], [6, at(35)], [8, hand(35)], [20, at(35)])).all)).toMatchObject({ startedAt: T0 + 12_000 });
  });

  test('no warm-up: a pickup at driving speed early in a drive counts from its first use second', () => {
    const c = ctx({ warmupEndsAt: T0 + 20_000 });
    expect(only(run(seq(REST, [8, hand(35)], [20, at(35)]), c).all)).toMatchObject({ startedAt: after(0), durationS: 8 });
    expect(only(run(seq(REST, [16, hand(35)], [20, at(35)]), c).all)).toMatchObject({ startedAt: after(0), durationS: 16 });
  });

  test('handling during a call is never a pickup (hands-free cannot be told from handheld), on iPhone and Android alike', () => {
    const rows = seq(REST, [10, hand(35, { call: 'live', screenOn: true })], [20, at(35)]);
    expect(run(rows, ctx({ platform: 'ios' })).all).toEqual([]);
    expect(run(rows, ctx({ platform: 'android' })).all).toEqual([]);
    // A call that starts mid-pickup ends the use seconds there: put down 10 s later.
    expect(only(run(seq(REST, [5, hand(35)], [20, hand(35, { call: 'ring' })], [20, at(35)]), ctx({ platform: 'ios' })).all)).toMatchObject({ durationS: 5 });
  });

  test('Android: only with the screen on (a phone moved in a pocket or a bag with its screen off is no pickup); iPhone reads no screen', () => {
    const off = seq(REST, [8, hand(35, { screenOn: false })], [20, at(35)]);
    expect(run(off, ctx({ platform: 'android' })).all).toEqual([]);
    expect(only(run(off, ctx({ platform: 'ios' })).all)).toMatchObject({ durationS: 8 });
    const on = seq(REST, [8, hand(35, { screenOn: true })], [20, at(35)]);
    expect(only(run(on, ctx({ platform: 'android' })).all)).toMatchObject({ startedAt: after(0), durationS: 8 });
    // The screen waking a second into the pickup: counted from the first second with it on.
    const wake = seq(REST, [1, hand(35, { screenOn: false })], [7, hand(35, { screenOn: true })], [20, at(35)]);
    expect(only(run(wake, ctx({ platform: 'android' })).all)).toMatchObject({ startedAt: after(1), durationS: 7 });
  });

  test('rows with the IMU absent have no reading: they neither open nor continue a pickup', () => {
    expect(run(seq(REST, [20, at(35, NO_IMU)], [20, at(35)])).all).toEqual([]);
    // 12 s with no reading put the first down; the first reading after them has no step to judge.
    expect(run(seq(REST, [4, hand(35)], [12, at(35, NO_IMU)], [4, hand(35)], [20, at(35)])).all.map((e) => e.durationS)).toEqual([4, 3]);
    // Rows from a build without the gravity keys: no reading either, so no rest and no pickup.
    const bare = (r: FeatureRow): FeatureRow => {
      const { gx: _x, gy: _y, gz: _z, ...rest } = r;
      return rest;
    };
    expect(run(seq(REST, [20, hand(35)], [20, at(35)]).map(bare)).all).toEqual([]);
  });

  test("the drive's end closes an open pickup as it stands; an unconfirmed one is nothing", () => {
    const det = createPhoneUseDetector(counterIds());
    for (const r of seq(REST, [8, hand(35)], [3, at(35)])) expect(det.push(r, NO_LIMIT, ctx())).toEqual([]);
    expect(det.flush()).toEqual([expect.objectContaining({ type: 'phone_pickup', startedAt: after(0), durationS: 8 })]);
    expect(det.flush()).toEqual([]);
    const short = createPhoneUseDetector(counterIds());
    for (const r of seq(REST, [2, hand(35)])) short.push(r, NO_LIMIT, ctx());
    expect(short.flush()).toEqual([]);
    // Held steady as the drive ends: those seconds never counted.
    const steady = createPhoneUseDetector(counterIds());
    for (const r of seq(REST, [4, hand(35)], [6, at(35, heldSteady)])) steady.push(r, NO_LIMIT, ctx());
    expect(steady.flush()).toEqual([expect.objectContaining({ durationS: 5 })]);
  });

  test('tier: up to 15 s in hand moderate, longer severe', () => {
    expect(only(run(seq(REST, [15, hand(35)], [20, at(35)])).all)).toMatchObject({ durationS: 15, tier: 'moderate' });
    expect(only(run(seq(REST, [16, hand(35)], [20, at(35)])).all)).toMatchObject({ durationS: 16, tier: 'severe' });
  });

  test('speedMph is the trusted speed at the start; maxSpeedMph the highest trusted speed from the start through the last second away (1 dp)', () => {
    const rows = seq([R, at(70)], [4, hand(30.04)], [1, hand(62, { speedAcc: 3 })], [2, at(48.04)], [4, hand(40)], [1, at(80)], [20, at(30)]);
    expect(only(run(rows).all).measured).toEqual({ speedMph: 30, maxSpeedMph: 48 });
  });

  test('the resting tilt follows the phone: a mount that sags slowly never reads as a pickup', () => {
    // From 85° to 40° at 1° a second (still each second), held to look at for the last 40 s of it.
    expect(run(seq(REST, [46, (i) => at(35, gravity(85 - (i - R)))], [60, at(35, gravity(40))])).all).toEqual([]);
  });
});

describe('phone alerts', () => {
  test('the second a pickup confirms, then a repeat at 15 s in hand and every 60 s more, none once put down', () => {
    expect(alertsOf(seq(REST, [80, hand(35)], [20, at(35)]))).toEqual([
      { i: R + 2, alert: { id: 'e1', tier: 'moderate', repeat: false } },
      { i: R + 14, alert: { id: 'e1', tier: 'moderate', repeat: true } },
      { i: R + 15 + PHONE_REPEAT_IN_HAND_S - 1, alert: { id: 'e1', tier: 'severe', repeat: true } },
    ]);
  });

  test('a repeat follows the time in hand, not the clock: a red light adds no time and no alert', () => {
    const told = alertsOf(seq(REST, [10, hand(35)], [120, hand(0)], [10, hand(35)], [20, at(35)])).map(({ i, alert }) => [i, alert.repeat]);
    // 10 s in hand before the light, 15 s on the 5th row after it.
    expect(told).toEqual([
      [R + 2, false],
      [R + 134, true],
    ]);
  });

  test('no alert for an episode that never counts', () => {
    expect(alertsOf(seq(REST, [20, hand(0)], [20, at(0)]))).toEqual([]);
  });
});
