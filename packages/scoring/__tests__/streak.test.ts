import { applyStreak, type StreakState } from '../src/streak';

const s = (p: Partial<StreakState> = {}): StreakState => ({ streak: 5, atRisk: false, freezes: 2, cleanRun: 0, ...p });
const clean = { scored: true, net: 50, activeEventCount: 0 };
const positiveWithEvents = { scored: true, net: 30, activeEventCount: 1 };
const negative = { scored: true, net: -20, activeEventCount: 2 };

describe('applyStreak — transitions', () => {
  test('an unscored drive changes nothing, even when at risk', () => {
    const at = s({ atRisk: true, cleanRun: 3 });
    expect(applyStreak(at, { scored: false, net: 0, activeEventCount: 0 })).toEqual({
      state: at,
      outcome: 'none',
      freezeEarned: false,
    });
  });

  test('net-positive drive grows the streak', () => {
    const r = applyStreak(s(), positiveWithEvents);
    expect(r.outcome).toBe('grew');
    expect(r.state).toEqual({ streak: 6, atRisk: false, freezes: 2, cleanRun: 0 });
  });

  test('net-zero drive is neither growth nor loss', () => {
    const r = applyStreak(s(), { scored: true, net: 0, activeEventCount: 1 });
    expect(r.outcome).toBe('none');
    expect(r.state.streak).toBe(5);
  });

  test('net-negative drive with a freeze uses it and holds the streak', () => {
    const r = applyStreak(s({ freezes: 2 }), negative);
    expect(r.outcome).toBe('freeze_used');
    expect(r.state).toEqual({ streak: 5, atRisk: false, freezes: 1, cleanRun: 0 });
  });

  test('net-negative drive without a freeze puts the streak at risk', () => {
    const r = applyStreak(s({ freezes: 0 }), negative);
    expect(r.outcome).toBe('at_risk');
    expect(r.state).toEqual({ streak: 5, atRisk: true, freezes: 0, cleanRun: 0 });
  });

  test('at risk, then a zero-event drive restores and grows the streak', () => {
    const r = applyStreak(s({ freezes: 0, atRisk: true }), clean);
    expect(r.outcome).toBe('restored');
    expect(r.state).toMatchObject({ streak: 6, atRisk: false });
  });

  test('at risk, then any events reset the streak — even on a net-positive drive', () => {
    const r = applyStreak(s({ freezes: 0, atRisk: true }), positiveWithEvents);
    expect(r.outcome).toBe('reset');
    expect(r.state).toMatchObject({ streak: 0, atRisk: false });
  });

  test('at risk, then another negative drive also resets', () => {
    const r = applyStreak(s({ freezes: 0, atRisk: true }), negative);
    expect(r.outcome).toBe('reset');
    expect(r.state).toMatchObject({ streak: 0, atRisk: false, freezes: 0 });
  });

  test('does not mutate the input state', () => {
    const before = s();
    applyStreak(before, negative);
    expect(before).toEqual(s());
  });
});

describe('applyStreak — clean-run freezes', () => {
  test('a clean scored drive extends the clean run', () => {
    expect(applyStreak(s({ cleanRun: 2 }), clean).state.cleanRun).toBe(3);
  });

  test('any events end the clean run', () => {
    expect(applyStreak(s({ cleanRun: 4 }), positiveWithEvents).state.cleanRun).toBe(0);
  });

  test('the 5th clean drive in a row earns a freeze and restarts the run', () => {
    const r = applyStreak(s({ freezes: 1, cleanRun: 4 }), clean);
    expect(r.freezeEarned).toBe(true);
    expect(r.state).toMatchObject({ freezes: 2, cleanRun: 0, streak: 6 });
  });

  test('freezes hold at most 3, and nothing is reported earned at the cap', () => {
    const r = applyStreak(s({ freezes: 3, cleanRun: 4 }), clean);
    expect(r.freezeEarned).toBe(false);
    expect(r.state).toMatchObject({ freezes: 3, cleanRun: 0 });
  });

  test('a restoring clean drive also counts toward the clean run', () => {
    const r = applyStreak(s({ atRisk: true, freezes: 0, cleanRun: 4 }), clean);
    expect(r.outcome).toBe('restored');
    expect(r.freezeEarned).toBe(true);
    expect(r.state).toEqual({ streak: 6, atRisk: false, freezes: 1, cleanRun: 0 });
  });

  test('an unscored drive leaves the clean run alone', () => {
    expect(applyStreak(s({ cleanRun: 4 }), { scored: false, net: 0, activeEventCount: 0 }).state.cleanRun).toBe(4);
  });
});
