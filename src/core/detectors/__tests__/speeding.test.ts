import { createSpeedingDetector } from '@/core/detectors/speeding';
import { counterIds, ctx, drive, limit, mph, NO_LIMIT, only, seq, T0 } from '@/core/detectors/__fixtures__/rows';

const L35 = limit(mph(35));

describe('speeding (spec "Speeding threshold")', () => {
  test('on a 35 (T = 5), 20 s at 41 mph is one minor incident of 20 s, measured at its peak', () => {
    const rows = seq([30, { speed: mph(34) }], [20, { speed: mph(41) }], [30, { speed: mph(34) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    const e = only(all);
    expect(e).toMatchObject({ type: 'speeding', tier: 'minor', startedAt: T0 + 30_000, durationS: 20 });
    expect(e.measured).toEqual({ speedMph: 41, limitMph: 35 });
  });

  test('tiers by peak: 44 mph on a 35 for 6 s is moderate; the tolerance table holds at every row of the spec', () => {
    const rows = seq([5, { speed: mph(34) }], [6, { speed: mph(46) }], [10, { speed: mph(34) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), rows, L35).all).tier).toBe('moderate');
    // L=25 → minor >28, moderate >33, severe >38 (spec table).
    const L25 = limit(mph(25));
    const at = (v: number) => only(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(v) }], [10, { speed: mph(20) }]), L25).all).tier;
    expect(at(29)).toBe('minor');
    expect(at(34)).toBe('moderate');
    expect(at(39)).toBe('severe');
    expect(drive(createSpeedingDetector(counterIds()), seq([6, { speed: mph(28) }], [10, { speed: mph(20) }]), L25).all).toEqual([]);
  });

  test('needs 5 s above the threshold, or 3 s once severe', () => {
    const blip = seq([4, { speed: mph(42) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), blip, L35).all).toEqual([]);
    const severe = seq([3, { speed: mph(52) }], [10, { speed: mph(30) }]);
    expect(only(drive(createSpeedingDetector(counterIds()), severe, L35).all)).toMatchObject({ tier: 'severe', durationS: 3 });
  });

  test('ends only after 5 s back under L + T − 2; hovering in the buffer keeps the episode open', () => {
    // 8 s over, 20 s hovering at 39 (between 38 and 40), 8 s over again: ONE incident, 16 s over.
    const rows = seq([8, { speed: mph(42) }], [20, { speed: mph(39) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    const { all } = drive(createSpeedingDetector(counterIds()), rows, L35);
    expect(only(all).durationS).toBe(16);
    // Dropping below 38 for 5 s closes it; the next excursion is a second incident.
    const two = seq([8, { speed: mph(42) }], [5, { speed: mph(36) }], [8, { speed: mph(42) }], [10, { speed: mph(30) }]);
    expect(drive(createSpeedingDetector(counterIds()), two, L35).all).toHaveLength(2);
  });

  test('no event in the first 30 s, with a poor fix (hAcc > 20 m), or without an actionable limit', () => {
    const fast = seq([40, { speed: mph(55) }], [10, { speed: mph(30) }]);
    const young = ctx({ tripStartedAt: T0 });
    const { all } = drive(createSpeedingDetector(counterIds()), fast, L35, young);
    // Only the rows from +30 s count: 10 over rows.
    expect(only(all).durationS).toBe(10);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55), hAcc: 25 }]), L35).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), NO_LIMIT).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { matchConfidence: 0.5 })).all).toEqual([]);
    expect(drive(createSpeedingDetector(counterIds()), seq([40, { speed: mph(55) }]), limit(mph(35), 'posted', { parallelRoads: true })).all).toEqual([]);
  });

  test('open() reports the live tier and confirmation for the glow and the one chime; active() covers the end window', () => {
    const det = createSpeedingDetector(counterIds());
    const rows = seq([3, { speed: mph(42) }], [3, { speed: mph(47) }], [3, { speed: mph(30) }]);
    const seen: (string | null)[] = [];
    const confirmed: boolean[] = [];
    for (const r of rows) {
      det.push(r, L35, ctx());
      const open = det.open();
      seen.push(open?.tier ?? null);
      confirmed.push(open?.confirmed ?? false);
    }
    expect(seen).toEqual(['minor', 'minor', 'minor', 'moderate', 'moderate', 'moderate', null, null, null]);
    expect(confirmed).toEqual([false, false, false, false, true, true, false, false, false]);
    expect(det.active()).toBe(true);
    det.push(rows[0]!, L35, ctx());
    expect(det.flush()).toHaveLength(1);
    expect(det.active()).toBe(false);
  });
});
