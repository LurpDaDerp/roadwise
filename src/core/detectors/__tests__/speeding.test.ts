import { createSpeedingDetector } from '@/core/detectors/speeding';
import { counterIds, ctx, drive, limit, mph, NO_LIMIT, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';

// On a 35, T = 4: the points line L + T is 39 mph; minor above 39, moderate above 43, severe above
// 48; the end buffer is under 37.
const L35 = limit(mph(35));

describe('speeding (spec "Speeding")', () => {
  test('on a 35, 20 s at 41 mph is one minor incident of 20 s, measured at its peak, charged past the grace', () => {
    const rows = seq([30, { speed: mph(34) }], [20, { speed: mph(41) }], [30, { speed: mph(34) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    const e = only(all);
    expect(e).toMatchObject({ type: 'speeding', tier: 'minor', startedAt: T0 + 30_000, durationS: 20 });
    // 15 rows after the 5-row grace, each 2 mph past the line.
    expect(e.measured.speedMph).toBe(41);
    expect(e.measured.limitMph).toBe(35);
    expect(e.measured.overMphS).toBeCloseTo(30, 6);
  });

  test('tiers by peak from the points line: 46 mph on a 35 for 6 s is moderate; the tolerance table holds', () => {
    const rows = seq([5, { speed: mph(34) }], [6, { speed: mph(46) }], [10, { speed: mph(34) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), rows, L35).all).tier).toBe('moderate');
    // L = 25 → T = 3: minor > 28, moderate > 32, severe > 37.
    const L25 = limit(mph(25));
    const at = (v: number) => only(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(v) }], [10, { speed: mph(20) }]), L25).all).tier;
    expect(at(28.5)).toBe('minor');
    expect(at(33)).toBe('moderate');
    expect(at(38)).toBe('severe');
    expect(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(28) }], [10, { speed: mph(20) }]), L25).all).toEqual([]);
    // L = 65 → T = 9: the line is 74.
    const L65 = limit(mph(65));
    expect(drive(createSpeedingDetector(counterIds()), seq([10, { speed: mph(74) }], [10, { speed: mph(60) }]), L65).all).toEqual([]);
    expect(only(drive(createSpeedingDetector(counterIds()), seq([10, { speed: mph(75) }], [10, { speed: mph(60) }]), L65).all).tier).toBe('minor');
  });

  test('the grace: an episode is an event only from its 6th over row, whatever its tier; only the rows after it are charged', () => {
    for (const v of [42, 52]) {
      const five = seq([5, { speed: mph(v) }], [10, { speed: mph(30) }]);
      expect(drive(createSpeedingDetector(counterIds()), five, L35).all).toEqual([]);
    }
    const six = seq([6, { speed: mph(52) }], [10, { speed: mph(30) }]);
    const e = only(drive(createSpeedingDetector(counterIds()), six, L35).all);
    expect(e).toMatchObject({ tier: 'severe', durationS: 6, startedAt: T0 });
    // Only the 6th row is charged: 52 − 39 = 13 mph.
    expect(e.measured.overMphS).toBeCloseTo(13, 6);
    // 7 rows: 5 at 45 (grace), then 45 and 41: 6 + 2.
    const seven = seq([6, { speed: mph(45) }], [1, { speed: mph(41) }], [10, { speed: mph(30) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), seven, L35).all).measured.overMphS).toBeCloseTo(8, 6);
  });

  test('overMphS is recorded to 1 dp', () => {
    const rows = seq([5, { speed: mph(41) }], [3, { speed: mph(39.33) }], [10, { speed: mph(30) }]);
    const e = only(drive(createSpeedingDetector(counterIds()), rows, L35).all);
    expect(e.measured.overMphS).toBe(1);
  });

  test('ends only after 5 s back under L + T − 2; hovering in the buffer keeps the episode open', () => {
    // 8 s over, 20 s hovering at 37 (between 37 and 39), 8 s over again: ONE incident, 16 s over.
    const rows = seq([8, { speed: mph(42) }], [20, { speed: mph(37) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    expect(only(all).durationS).toBe(16);
    // 11 rows after the grace, 3 mph past the line each.
    expect(only(all).measured.overMphS).toBeCloseTo(33, 6);
    // Dropping below 37 for 5 s closes it; the next excursion is a second incident.
    const two = seq([8, { speed: mph(42) }], [5, { speed: mph(34) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), two, L35).all).toHaveLength(2);
  });

  test('no event in the warm-up, with a poor fix (hAcc > 20 m), or without an actionable limit', () => {
    const fast = seq([40, { speed: mph(55) }], [10, { speed: mph(30) }]);
    const young = ctx({ warmupEndsAt: T0 + 30_000 });
    const { all } = drive(createSpeedingDetector(counterIds()), fast, L35, young);
    // Only the rows from +30 s count: 10 over rows.
    expect(only(all)).toMatchObject({ durationS: 10, startedAt: T0 + 30_000 });
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55), hAcc: 25 }]), L35).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), NO_LIMIT).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'statutory')).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { matchConfidence: 0.5 })).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { parallelRoads: true })).all).toEqual([]);
  });

  test('within the grace, rows back under the line do not restart it: the over rows of one episode add up', () => {
    // 3 s over, one row under, 3 s over: one episode, an event on its 6th over row.
    const split = seq([3, { speed: mph(42) }], [1, { speed: mph(34) }], [3, { speed: mph(42) }], [10, { speed: mph(30) }]);
    const det = createSpeedingDetector(counterIds());
    const { pushed, all } = drive(det, split, L35);
    expect(only(all)).toMatchObject({ durationS: 6, startedAt: T0 });
    // It closes on the 5th row back under the buffer (rows 7..11).
    expect(pushed.findIndex((p) => p.length > 0)).toBe(11);
    // Five 1-s blips to 41 with 37 (inside the buffer) between them: five over rows, within the
    // grace: never an event, no safe miles taken.
    const blips = createSpeedingDetector(counterIds());
    const rows = seq([40, (i) => ({ speed: mph(i % 8 === 0 ? 41 : 37) })], [10, { speed: mph(30) }]);
    const actives: boolean[] = [];
    for (const r of rows) {
      blips.push(r, L35, ctx());
      actives.push(blips.active());
    }
    expect(blips.flush()).toEqual([]);
    expect(actives.every((a) => !a)).toBe(true);
    // A sixth blip in the same episode makes it one.
    const six = seq([48, (i) => ({ speed: mph(i % 8 === 0 ? 41 : 37) })], [10, { speed: mph(30) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), six, L35).all)).toMatchObject({ durationS: 6, startedAt: T0 });
    // Once past the grace, hovering in the buffer keeps it (and its safe-mile exclusion) going.
    const confirmed = createSpeedingDetector(counterIds());
    for (const r of seq([6, { speed: mph(42) }], [3, { speed: mph(37) }])) confirmed.push(r, L35, ctx());
    expect(confirmed.active()).toBe(true);
    expect(confirmed.flush()).toHaveLength(1);
  });

  test('open() reports the live tier and the grace; episode() the whole episode; active() covers the end window', () => {
    const det = createSpeedingDetector(counterIds());
    const rows = seq([3, { speed: mph(42) }], [3, { speed: mph(47) }], [3, { speed: mph(30) }]);
    const seen: (string | null)[] = [];
    const confirmed: boolean[] = [];
    const episodes: (string | null)[] = [];
    for (const r of rows) {
      det.push(r, L35, ctx());
      const open = det.open();
      seen.push(open?.tier ?? null);
      confirmed.push(open?.confirmed ?? false);
      const ep = det.episode();
      episodes.push(ep === null ? null : `${ep.overRows}:${ep.over ? 'over' : 'under'}:${ep.confirmed ? 'event' : 'grace'}`);
    }
    expect(seen).toEqual(['minor', 'minor', 'minor', 'moderate', 'moderate', 'moderate', null, null, null]);
    expect(confirmed).toEqual([false, false, false, false, false, true, false, false, false]);
    expect(episodes).toEqual([
      '1:over:grace',
      '2:over:grace',
      '3:over:grace',
      '4:over:grace',
      '5:over:grace',
      '6:over:event',
      '6:under:event',
      '6:under:event',
      '6:under:event',
    ]);
    expect(det.episode()!.overMphS).toBeCloseTo(47 - 39, 6);
    expect(det.active()).toBe(true); // past the grace, in its end window
    det.push(rows[0]!, L35, ctx());
    expect(det.flush()).toHaveLength(1);
    expect(det.active()).toBe(false);
    expect(det.episode()).toBeNull();
  });

  test('reading(): the row speed over the posted limit and the mph past the line, on usable rows only', () => {
    const det = createSpeedingDetector(counterIds());
    det.push(seq([1, { speed: mph(42) }])[0]!, L35, ctx());
    expect(det.reading()!.ratio).toBeCloseTo(42 / 35, 9);
    expect(det.reading()!.overMph).toBeCloseTo(3, 9);
    det.push(seq([1, { speed: mph(30) }])[0]!, L35, ctx());
    expect(det.reading()!.overMph).toBeCloseTo(-9, 9);
    det.push(seq([1, { speed: mph(42) }])[0]!, NO_LIMIT, ctx());
    expect(det.reading()).toBeNull();
    det.push(seq([1, { speed: mph(42), speedAcc: 3 }])[0]!, L35, ctx());
    expect(det.reading()).toBeNull();
    det.push(seq([1, { speed: mph(42) }])[0]!, L35, ctx({ warmupEndsAt: T0 + 10_000 }));
    expect(det.reading()).toBeNull();
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

  test('an untrusted row is not an over row: it counts toward the end, never toward the grace', () => {
    // 3 over, 1 untrusted, 2 over: five over rows, within the grace.
    const rows = seq([3, { speed: mph(46) }], [1, { speed: mph(46), speedAcc: 3 }], [2, { speed: mph(46) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), rows, L35).all).toEqual([]);
    // Five untrusted rows in a row end the episode: the next over rows start a new grace.
    const ended = seq([3, { speed: mph(46) }], [5, { speed: mph(46), speedAcc: 3 }], [3, { speed: mph(46) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), ended, L35).all).toEqual([]);
  });

  test('an episode past its grace whose rows turn untrusted ends after SPEEDING_END_S, as on a poor fix', () => {
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
