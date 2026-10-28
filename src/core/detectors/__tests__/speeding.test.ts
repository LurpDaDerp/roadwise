import { createSpeedingDetector } from '@/core/detectors/speeding';
import { round1 } from '@/core/detectors/common';
import { counterIds, ctx, drive, limit, mph, NO_LIMIT, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';

// On a 35, T = 4.8: the speeding line 1.16 L − 0.8 is 39.8 mph; minor above 39.8, moderate above
// 43.8, severe above 48.8; the end buffer is under 37.8.
const L35 = limit(mph(35));

describe('speeding (spec "Speeding")', () => {
  test('on a 35, 20 s at 41 mph is one minor incident of 20 s, measured at its peak, every second charged', () => {
    const rows = seq([30, { speed: mph(34) }], [20, { speed: mph(41) }], [30, { speed: mph(34) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    const e = only(all);
    expect(e).toMatchObject({ type: 'speeding', tier: 'minor', startedAt: T0 + 30_000, durationS: 20 });
    // All 20 rows, each 1.2 mph past the line.
    expect(e.measured.speedMph).toBe(41);
    expect(e.measured.limitMph).toBe(35);
    expect(e.measured.overMphS).toBeCloseTo(24, 6);
  });

  test('tiers by peak from the speeding line: 46 mph on a 35 for 6 s is moderate; the tolerance table holds', () => {
    const rows = seq([5, { speed: mph(34) }], [6, { speed: mph(46) }], [10, { speed: mph(34) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), rows, L35).all).tier).toBe('moderate');
    // L = 25 → T = 3.2: minor > 28.2, moderate > 32.2, severe > 37.2.
    const L25 = limit(mph(25));
    const at = (v: number) => only(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(v) }], [10, { speed: mph(20) }]), L25).all).tier;
    expect(at(28.5)).toBe('minor');
    expect(at(33)).toBe('moderate');
    expect(at(38)).toBe('severe');
    expect(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(28) }], [10, { speed: mph(20) }]), L25).all).toEqual([]);
    // L = 65 → T = 9.6: the line is 74.6.
    const L65 = limit(mph(65));
    expect(drive(createSpeedingDetector(counterIds()), seq([10, { speed: mph(74) }], [10, { speed: mph(60) }]), L65).all).toEqual([]);
    expect(only(drive(createSpeedingDetector(counterIds()), seq([10, { speed: mph(75) }], [10, { speed: mph(60) }]), L65).all).tier).toBe('minor');
  });

  test('no grace: every episode is an event from its first over row, however short, and every row is charged', () => {
    // A single second just over the line is an event of 1 s.
    const one = only(drive(createSpeedingDetector(counterIds()), seq([1, { speed: mph(40) }], [10, { speed: mph(30) }]), L35).all);
    expect(one).toMatchObject({ tier: 'minor', durationS: 1, startedAt: T0 });
    expect(one.measured.overMphS).toBeCloseTo(0.2, 6);
    for (const v of [42, 52]) {
      const five = only(drive(createSpeedingDetector(counterIds()), seq([5, { speed: mph(v) }], [10, { speed: mph(30) }]), L35).all);
      expect(five).toMatchObject({ durationS: 5, startedAt: T0 });
      expect(five.measured.overMphS).toBeCloseTo(round1(5 * (v - 39.8)), 6);
    }
    // 7 rows: 6 at 45 and one at 41: 6 × 5.2 + 1.2.
    const seven = seq([6, { speed: mph(45) }], [1, { speed: mph(41) }], [10, { speed: mph(30) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), seven, L35).all).measured.overMphS).toBeCloseTo(32.4, 6);
  });

  test('overMphS is recorded to 1 dp', () => {
    const rows = seq([3, { speed: mph(40.13) }], [10, { speed: mph(30) }]);
    const e = only(drive(createSpeedingDetector(counterIds()), rows, L35).all);
    expect(e.measured.overMphS).toBe(1);
  });

  test('ends only after 5 s back under the line less 2; hovering in the buffer keeps the episode open', () => {
    // 8 s over, 20 s hovering at 38 (between 37.8 and 39.8), 8 s over again: ONE incident, 16 s over.
    const rows = seq([8, { speed: mph(42) }], [20, { speed: mph(38) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    expect(only(all).durationS).toBe(16);
    // 16 rows, 2.2 mph past the line each; the hover adds nothing.
    expect(only(all).measured.overMphS).toBeCloseTo(35.2, 6);
    // Dropping below 37.8 for 5 s closes it; the next excursion is a second incident.
    const two = seq([8, { speed: mph(42) }], [5, { speed: mph(34) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), two, L35).all).toHaveLength(2);
  });

  test('no warm-up: speeding counts from the first row; no event with a poor fix (hAcc > 20 m) or without an actionable limit', () => {
    const fast = seq([40, { speed: mph(55) }], [10, { speed: mph(30) }]);
    const young = ctx({ warmupEndsAt: T0 + 30_000 });
    expect(only(drive(createSpeedingDetector(counterIds()), fast, L35, young).all)).toMatchObject({ durationS: 40, startedAt: T0 });
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55), hAcc: 25 }]), L35).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), NO_LIMIT).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'statutory')).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { matchConfidence: 0.5 })).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { parallelRoads: true })).all).toEqual([]);
  });

  test('rows back under the line inside the end window do not restart it: the over rows of one episode add up', () => {
    // 3 s over, one row under, 3 s over: one episode of 6 over rows.
    const split = seq([3, { speed: mph(42) }], [1, { speed: mph(34) }], [3, { speed: mph(42) }], [10, { speed: mph(30) }]);
    const det = createSpeedingDetector(counterIds());
    const { pushed, all } = drive(det, split, L35);
    expect(only(all)).toMatchObject({ durationS: 6, startedAt: T0 });
    // It closes on the 5th row back under the buffer (rows 7..11).
    expect(pushed.findIndex((p) => p.length > 0)).toBe(11);
    // Five 1-s blips to 41 with 38 (inside the buffer) between them: one episode of five over rows,
    // one event, and its distance is not safe miles from the first blip.
    const blips = createSpeedingDetector(counterIds());
    const rows = seq([40, (i) => ({ speed: mph(i % 8 === 0 ? 41 : 38) })], [10, { speed: mph(30) }]);
    const actives: boolean[] = [];
    const closed = [];
    for (const r of rows) {
      closed.push(...blips.push(r, L35, ctx()));
      actives.push(blips.active());
    }
    closed.push(...blips.flush());
    expect(only(closed)).toMatchObject({ durationS: 5, startedAt: T0 });
    expect(actives.slice(0, 40).every((a) => a)).toBe(true);
  });

  test('open() reports the live tier; episode() the whole episode; active() covers the end window', () => {
    const det = createSpeedingDetector(counterIds());
    const rows = seq([3, { speed: mph(42) }], [3, { speed: mph(47) }], [3, { speed: mph(30) }]);
    const seen: (string | null)[] = [];
    const episodes: (string | null)[] = [];
    const actives: boolean[] = [];
    for (const r of rows) {
      det.push(r, L35, ctx());
      seen.push(det.open()?.tier ?? null);
      const ep = det.episode();
      episodes.push(ep === null ? null : `${ep.overRows}:${ep.over ? 'over' : 'under'}`);
      actives.push(det.active());
    }
    expect(seen).toEqual(['minor', 'minor', 'minor', 'moderate', 'moderate', 'moderate', null, null, null]);
    expect(episodes).toEqual(['1:over', '2:over', '3:over', '4:over', '5:over', '6:over', '6:under', '6:under', '6:under']);
    expect(actives.every((a) => a)).toBe(true);
    expect(det.episode()!.overMphS).toBeCloseTo(3 * 2.2 + 3 * 7.2, 6);
    det.push(rows[0]!, L35, ctx());
    expect(det.flush()).toHaveLength(1);
    expect(det.active()).toBe(false);
    expect(det.episode()).toBeNull();
  });

  test('reading(): the row speed over the posted limit and the mph past the line, on usable rows only (the warm-up does not matter)', () => {
    const det = createSpeedingDetector(counterIds());
    det.push(seq([1, { speed: mph(42) }])[0]!, L35, ctx());
    expect(det.reading()!.ratio).toBeCloseTo(42 / 35, 9);
    expect(det.reading()!.overMph).toBeCloseTo(2.2, 9);
    det.push(seq([1, { speed: mph(30) }])[0]!, L35, ctx());
    expect(det.reading()!.overMph).toBeCloseTo(-9.8, 9);
    det.push(seq([1, { speed: mph(42) }])[0]!, NO_LIMIT, ctx());
    expect(det.reading()).toBeNull();
    det.push(seq([1, { speed: mph(42), speedAcc: 3 }])[0]!, L35, ctx());
    expect(det.reading()).toBeNull();
    det.push(seq([1, { speed: mph(42) }])[0]!, L35, ctx({ warmupEndsAt: T0 + 10_000 }));
    expect(det.reading()!.ratio).toBeCloseTo(42 / 35, 9);
  });
});

describe('speeding reads only trusted speeds (speed accuracy 2 m/s or better, or unrated)', () => {
  const over = (acc: number) => seq([10, { speed: mph(34) }], [20, { speed: mph(46), speedAcc: acc }], [10, { speed: mph(34) }]);

  test('20 s over the limit at speedAcc 3 is no event; at -1, 1.5 and exactly 2 it is one', () => {
    expect(drive(createSpeedingDetector(counterIds()), over(3), L35).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), over(2.01), L35).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), over(Number.NaN), L35).all).toEqual([]);
    for (const a of [-1, 1.5, 2]) expect(only(drive(createSpeedingDetector(counterIds()), over(a), L35).all)).toMatchObject({ durationS: 20 });
  });

  test('an untrusted row is not an over row: it counts toward the end, never toward the seconds over', () => {
    // 3 over, 1 untrusted, 2 over: one episode of five over rows.
    const rows = seq([3, { speed: mph(46) }], [1, { speed: mph(46), speedAcc: 3 }], [2, { speed: mph(46) }], [10, { speed: mph(30) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), rows, L35).all)).toMatchObject({ durationS: 5 });
    // Five untrusted rows in a row end the episode: the next over rows start a new one.
    const ended = seq([3, { speed: mph(46) }], [5, { speed: mph(46), speedAcc: 3 }], [3, { speed: mph(46) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), ended, L35).all.map((e) => e.durationS)).toEqual([3, 3]);
  });

  test('an episode whose rows turn untrusted ends after SPEEDING_END_S, as on a poor fix', () => {
    const rows = seq([8, { speed: mph(46) }], [20, { speed: mph(46), speedAcc: 5 }], [10, { speed: mph(30) }]);
    const det = createSpeedingDetector(counterIds());
    const { pushed, all } = drive(det, rows, L35);
    expect(only(all)).toMatchObject({ durationS: 8, startedAt: T0 });
    // Closed on the fifth untrusted row (rows 8..12), not held open by them.
    expect(pushed.findIndex((p) => p.length > 0)).toBe(12);
  });

  test('open() is null on an untrusted row: the HUD tier follows', () => {
    const det = createSpeedingDetector(counterIds());
    det.push(seq([1, { speed: mph(46), speedAcc: 3 }])[0]!, L35, ctx());
    expect(det.open()).toBeNull();
  });
});
