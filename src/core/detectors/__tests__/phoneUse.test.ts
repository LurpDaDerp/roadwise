import { createPhoneUseDetector, isUseRow, PHONE_REPEAT_IN_HAND_S } from '@/core/detectors/phoneUse';
import { counterIds, ctx, drive, mph, NO_LIMIT, only, row, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { DetectorContext, FeatureRow, PhoneAlert } from '@/core/engine/types';

/** A second of the phone in the hand. */
const handled = { handlingScore: 0.9, gravityStability: 0.6, orientationDelta: 0.2 };
/** Held still in the hand: no handling motion. */
const heldStill = { handlingScore: 0.3, gravityStability: 0.8 };
const at = (mphV: number, extra: Partial<FeatureRow> = {}): Partial<FeatureRow> => ({ speed: mph(mphV), ...extra });
const use = (mphV: number, extra: Partial<FeatureRow> = {}): Partial<FeatureRow> => ({ speed: mph(mphV), ...handled, ...extra });
/** The IMU-absent encoding: every IMU field 0. */
const NO_IMU = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };

const run = (rows: FeatureRow[], c: DetectorContext = ctx()) => drive(createPhoneUseDetector(counterIds()), rows, NO_LIMIT, c);

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

describe('a use row', () => {
  test('handled (score 0.6 or more) with the IMU read; on iPhone never during a call; Android always', () => {
    expect(isUseRow(row({ handlingScore: 0.6, gravityStability: 0.7 }), 'ios')).toBe(true);
    expect(isUseRow(row({ handlingScore: 0.59, gravityStability: 0.7 }), 'ios')).toBe(false);
    expect(isUseRow(row({ ...handled, call: 'live' }), 'ios')).toBe(false);
    expect(isUseRow(row({ ...handled, call: 'ring' }), 'ios')).toBe(false);
    expect(isUseRow(row({ ...handled, call: 'live' }), 'android')).toBe(true);
    expect(isUseRow(row(NO_IMU), 'ios')).toBe(false);
    expect(isUseRow(row({ ...handled, handlingScore: Number.NaN }), 'android')).toBe(false);
  });
});

describe('phone pickups (phone plan P1)', () => {
  test('8 s handled at 35 mph is one moderate pickup of 8 s, told once it is put down (10 s after its last use row ends)', () => {
    const rows = seq([10, at(35)], [8, use(35)], [20, at(35)]);
    const { pushed, all } = run(rows);
    const e = only(all);
    expect(e).toMatchObject({ id: 'e1', type: 'phone_pickup', tier: 'moderate', startedAt: T0 + 10_000, durationS: 8 });
    expect(e.measured).toEqual({ speedMph: 35, maxSpeedMph: 35 });
    // The last use row is row 17 (it ends at 18): the put-down is row 28, 10 s of row clock later.
    expect(pushed.findIndex((p) => p.length > 0)).toBe(28);
  });

  test('a tap of under 3 use rows is never a pickup', () => {
    expect(run(seq([10, at(35)], [2, use(35)], [20, at(35)])).all).toEqual([]);
  });

  test('before it is a pickup, two quiet rows drop it: two 1-row spikes 5 s apart never confirm', () => {
    expect(run(seq([10, at(35)], [1, use(35)], [4, at(35)], [1, use(35)], [4, at(35)], [1, use(35)], [20, at(35)])).all).toEqual([]);
  });

  test('a mounted phone on a rough road (a 1-row spike every 3 s, then 2-row jolts every 4 s, for 2 min) never confirms', () => {
    const rough = seq([10, at(35)], [60, (i) => at(35, i % 3 === 0 ? handled : {})], [60, (i) => at(35, i % 4 < 2 ? handled : {})], [20, at(35)]);
    expect(rough.filter((r) => r.handlingScore >= 0.6).length).toBe(50);
    expect(run(rough).all).toEqual([]);
    expect(alertsOf(rough)).toEqual([]);
    // 2-row jolts with 2 quiet rows between never reach 3 use rows in one episode.
    expect(run(seq([10, at(35)], [2, use(35)], [2, at(35)], [2, use(35)], [2, at(35)], [2, use(35)], [20, at(35)])).all).toEqual([]);
    // Nor do spikes with a gap of 2 s or more in the rows between them.
    const rowsAt = (ts: number[]): FeatureRow[] => ts.map((s) => row({ ...use(35), ts: T0 + s * 1000 }));
    expect(run([...rowsAt([10, 13, 16, 19]), row({ ...at(35), ts: T0 + 60_000 })]).all).toEqual([]);
  });

  test('a real pickup with a one-row dip in the handling still confirms, the dip in its time in hand', () => {
    const rows = seq([10, at(35)], [1, use(35)], [1, at(35)], [1, use(35)], [1, at(35)], [4, use(35)], [20, at(35)]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 8 });
    expect(alertsOf(rows)).toEqual([{ i: 14, alert: { id: 'e1', tier: 'moderate', repeat: false } }]);
    // A missing row (a 1 s gap) is a dip too.
    const rowsAt = (ts: number[]): FeatureRow[] => ts.map((s) => row({ ...use(35), ts: T0 + s * 1000 }));
    expect(only(run([...rowsAt([10, 12, 14]), row({ ...at(35), ts: T0 + 60_000 })]).all)).toMatchObject({ durationS: 3 });
  });

  test('the put-down motion is never a second pickup: one pickup through it', () => {
    const rows = seq([10, at(35)], [8, use(35)], [3, at(35)], [2, use(35)], [20, at(35)]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 13 });
  });

  test('a re-grab 6 s after the last use row is the same pickup, the time between included', () => {
    const rows = seq([10, at(35)], [5, use(35)], [5, at(35)], [5, use(35)], [20, at(35)]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 15, tier: 'moderate' });
  });

  test('a re-grab 12 s after is a second pickup; 10 s after (9 s without) the same one, 11 s after (10 s without) a second', () => {
    const twelve = run(seq([10, at(35)], [5, use(35)], [11, at(35)], [5, use(35)], [20, at(35)])).all;
    expect(twelve.map((e) => [e.startedAt - T0, e.durationS])).toEqual([
      [10_000, 5],
      [26_000, 5],
    ]);
    // Last use row 14; the next at 24 (9 quiet seconds) or 25 (10).
    expect(run(seq([10, at(35)], [5, use(35)], [9, at(35)], [5, use(35)], [20, at(35)])).all).toHaveLength(1);
    expect(run(seq([10, at(35)], [5, use(35)], [10, at(35)], [5, use(35)], [20, at(35)])).all).toHaveLength(2);
  });

  test('held still in the hand under 10 s stays one pickup; 10 s still and it was put down', () => {
    const still9 = run(seq([10, at(35)], [4, use(35)], [9, at(35, heldStill)], [4, use(35)], [20, at(35)])).all;
    expect(only(still9)).toMatchObject({ durationS: 17 });
    const still10 = run(seq([10, at(35)], [4, use(35)], [10, at(35, heldStill)], [4, use(35)], [20, at(35)])).all;
    expect(still10.map((e) => e.durationS)).toEqual([4, 4]);
  });

  test('a pickup at a red light put down before the car reaches 10 mph never counts', () => {
    const rows = seq([10, at(35)], [10, at(0)], [10, use(0)], [12, at(0)], [3, at(6)], [20, at(35)]);
    expect(run(rows).all).toEqual([]);
    // 5 to 9 mph (moving, below driving speed) is not driving speed either.
    expect(run(seq([10, at(35)], [10, use(8)], [12, at(8)], [20, at(35)])).all).toEqual([]);
    // An untrusted 35 mph is not driving speed.
    expect(run(seq([10, at(0)], [10, use(35, { speedAcc: 3 })], [12, at(0)])).all).toEqual([]);
  });

  test('picked up stopped, then driving off with it: counted from the first use row at driving speed', () => {
    const rows = seq([10, at(0)], [10, use(0)], [3, use(9)], [6, use(12)], [20, at(35)]);
    const e = only(run(rows).all);
    expect(e).toMatchObject({ startedAt: T0 + 23_000, durationS: 6 });
    expect(e.measured).toEqual({ speedMph: 12, maxSpeedMph: 12 });
  });

  test('time in hand at a red light adds nothing, nor after parking', () => {
    const light = run(seq([10, at(35)], [5, use(35)], [20, use(0)], [5, use(35)], [20, at(35)])).all;
    expect(only(light)).toMatchObject({ startedAt: T0 + 10_000, durationS: 10 });
    // Parked with it in hand to the end of the drive: only the moving seconds.
    const parked = run(seq([10, at(35)], [5, use(35)], [30, use(0)])).all;
    expect(only(parked)).toMatchObject({ durationS: 5 });
    // 4 mph (under 5) is a stop too; 5 mph counts.
    expect(only(run(seq([10, at(35)], [5, use(35)], [3, use(4)], [3, use(5)], [20, at(35)])).all)).toMatchObject({ durationS: 8 });
  });

  test('a GPS gap: handled rows with no fix continue the pickup and add nothing to its time in hand', () => {
    const gap = { gnssValid: false, speed: -1 };
    const rows = seq([10, at(35)], [5, use(35)], [12, { ...handled, ...gap }], [5, use(35)], [20, at(35)]);
    expect(only(run(rows).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 10 });
    // A gap with no rows at all: time decides, so 30 s missing put it down and 8 s did not.
    const rowsAt = (ts: number[]): FeatureRow[] => ts.map((s) => row({ ...use(35), ts: T0 + s * 1000 }));
    expect(run([...rowsAt([10, 11, 12, 13]), ...rowsAt([44, 45, 46, 47]), row({ ...at(35), ts: T0 + 90_000 })]).all).toHaveLength(2);
    expect(only(run([...rowsAt([10, 11, 12, 13]), ...rowsAt([21, 22, 23]), row({ ...at(35), ts: T0 + 90_000 })]).all)).toMatchObject({ durationS: 7 });
  });

  test('no warm-up: a pickup at driving speed in the first seconds of a drive counts from its first use row', () => {
    const c = ctx({ warmupEndsAt: T0 + 20_000 });
    expect(only(run(seq([10, at(35)], [8, use(35)], [20, at(35)]), c).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 8 });
    expect(only(run(seq([10, at(35)], [16, use(35)], [20, at(35)]), c).all)).toMatchObject({ startedAt: T0 + 10_000, durationS: 16 });
  });

  test('iPhone: handling during a call is never a pickup (hands-free cannot be told from handheld); Android counts it', () => {
    const rows = seq([10, at(35)], [10, use(35, { call: 'live' })], [20, at(35)]);
    expect(run(rows, ctx({ platform: 'ios' })).all).toEqual([]);
    expect(only(run(rows, ctx({ platform: 'android' })).all)).toMatchObject({ durationS: 10 });
    // A call that starts mid-pickup on iPhone ends the use rows there: put down 10 s later.
    const mid = seq([10, at(35)], [5, use(35)], [20, use(35, { call: 'ring' })], [20, at(35)]);
    expect(only(run(mid, ctx({ platform: 'ios' })).all)).toMatchObject({ durationS: 5 });
  });

  test('rows with the IMU absent are never use rows: they neither open nor continue a pickup', () => {
    expect(run(seq([10, at(35)], [20, at(35, NO_IMU)], [20, at(35)])).all).toEqual([]);
    const rows = seq([10, at(35)], [4, use(35)], [12, at(35, NO_IMU)], [4, use(35)], [20, at(35)]);
    expect(run(rows).all.map((e) => e.durationS)).toEqual([4, 4]);
  });

  test("the drive's end closes an open pickup at its last use row; an unconfirmed one is nothing", () => {
    const det = createPhoneUseDetector(counterIds());
    for (const r of seq([10, at(35)], [8, use(35)], [3, at(35)])) expect(det.push(r, NO_LIMIT, ctx())).toEqual([]);
    expect(det.flush()).toEqual([expect.objectContaining({ type: 'phone_pickup', startedAt: T0 + 10_000, durationS: 8 })]);
    expect(det.flush()).toEqual([]);
    const short = createPhoneUseDetector(counterIds());
    for (const r of seq([10, at(35)], [2, use(35)])) short.push(r, NO_LIMIT, ctx());
    expect(short.flush()).toEqual([]);
  });

  test('tier: up to 15 s in hand moderate, longer severe', () => {
    expect(only(run(seq([10, at(35)], [15, use(35)], [20, at(35)])).all)).toMatchObject({ durationS: 15, tier: 'moderate' });
    expect(only(run(seq([10, at(35)], [16, use(35)], [20, at(35)])).all)).toMatchObject({ durationS: 16, tier: 'severe' });
  });

  test('speedMph is the trusted speed at the start row; maxSpeedMph the highest trusted speed from the start through the last use row (1 dp)', () => {
    const rows = seq(
      [10, at(70)],
      [4, use(30.04)],
      [1, use(62, { speedAcc: 3 })],
      [2, at(48.04)],
      [4, use(40)],
      [1, at(80)],
      [20, at(30)]
    );
    expect(only(run(rows).all).measured).toEqual({ speedMph: 30, maxSpeedMph: 48 });
  });
});

describe('phone alerts', () => {
  test('the row a pickup confirms, then a repeat at 15 s in hand and every 60 s more, none once put down', () => {
    const rows = seq([10, at(35)], [80, use(35)], [20, at(35)]);
    const told = alertsOf(rows);
    expect(told).toEqual([
      { i: 12, alert: { id: 'e1', tier: 'moderate', repeat: false } },
      { i: 24, alert: { id: 'e1', tier: 'moderate', repeat: true } },
      { i: 10 + 15 + PHONE_REPEAT_IN_HAND_S - 1, alert: { id: 'e1', tier: 'severe', repeat: true } },
    ]);
  });

  test('a repeat follows the time in hand, not the clock: a red light adds no time and no alert', () => {
    const rows = seq([10, at(35)], [10, use(35)], [120, use(0)], [10, use(35)], [20, at(35)]);
    const told = alertsOf(rows).map(({ i, alert }) => [i, alert.repeat]);
    // 10 s in hand before the light, 15 s on the 5th row after it (row 144).
    expect(told).toEqual([
      [12, false],
      [144, true],
    ]);
  });


  test('no alert for an episode that never counts', () => {
    expect(alertsOf(seq([10, at(0)], [20, use(0)], [20, at(0)]))).toEqual([]);
  });
});
