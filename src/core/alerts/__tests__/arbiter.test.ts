import { CONSTANTS } from '@scoring';
import { createArbiter } from '@/core/alerts/arbiter';
import { en } from '@/i18n/en';
import type { ArbiterInput, ArbiterState } from '@/core/alerts/types';

const {
  MPH,
  ALERT_L1_SPEEDING_MIN_S,
  ALERT_L2_PERSIST_S,
  ALERT_REALERT_S,
  ALERT_SPEEDING_RESET_S,
  Q_FULL_AT,
} = CONSTANTS;

const mph = (v: number) => v * MPH;

/** Every timeline is scripted in whole seconds from an arbitrary epoch. */
const T0 = 1_700_000_000_000;
const at = (s: number) => T0 + s * 1000;

/**
 * A quiet 1 Hz row: cruising at the limit, camera clean, nothing to say about it. Each test
 * overrides only the fields its rule cares about, so a timeline reads as the story it tells.
 */
const QUIET: Omit<ArbiterInput, 'ts'> = {
  speedMps: mph(35),
  limitMps: mph(35),
  overMps: 0,
  overForS: 0,
  q: 1,
  drivingS: 0,
};

function harness(state: Partial<ArbiterState> = {}) {
  // Default past the learning period: the downgrade has its own describe.
  const arbiter = createArbiter({ tripIndex: CONSTANTS.LEARNING_PERIOD_TRIPS, ...state });
  return {
    arbiter,
    /** Feed the row for second `s` of the drive. */
    tick: (s: number, input: Partial<Omit<ArbiterInput, 'ts'>> = {}) =>
      arbiter.consider({ ...QUIET, ...input, ts: at(s) }),
  };
}

/** Seconds `from`..`to` inclusive of a steady speeding episode, as `tick` arguments. */
function speedingRow(s: number, overMps: number, startedAtS = 0) {
  return { overMps, overForS: s - startedAtS, speedMps: mph(35) + overMps };
}

describe('rule 2: speeding', () => {
  const OVER_9 = mph(9);
  const OVER_16 = mph(16);
  const OVER_21 = mph(21);

  test('L1 once `overMps > 0` has held for ALERT_L1_SPEEDING_MIN_S with q ≥ Q_FULL_AT', () => {
    const { tick } = harness();
    for (let s = 0; s < ALERT_L1_SPEEDING_MIN_S; s += 1) {
      expect(tick(s, speedingRow(s, OVER_9))).toBeNull();
    }
    const decision = tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9));
    expect(decision).toMatchObject({
      level: 1,
      kind: 'speeding',
      voice: 'alert.easeOff',
      ts: at(ALERT_L1_SPEEDING_MIN_S),
    });
  });

  test('stays silent below Q_FULL_AT, at any band', () => {
    const { tick } = harness();
    for (let s = 0; s <= 20; s += 1) {
      expect(tick(s, { ...speedingRow(s, OVER_21), q: Q_FULL_AT - 0.01 })).toBeNull();
    }
    // The same row at full quality is an L3 — only `q` was holding it back.
    expect(tick(21, { ...speedingRow(21, OVER_21), q: Q_FULL_AT })).toMatchObject({ level: 3 });
  });

  test('opens at L2 when already ALERT_L2_OVER_MPS over', () => {
    const { tick } = harness();
    expect(tick(4, speedingRow(4, OVER_16))).toBeNull();
    expect(tick(5, speedingRow(5, OVER_16))).toMatchObject({
      level: 2,
      kind: 'speeding',
      voice: 'alert.easeOff',
    });
  });

  test('escalates L1 → L2 after the L1 state persists ALERT_L2_PERSIST_S', () => {
    const { tick } = harness();
    const escalateAtS = ALERT_L1_SPEEDING_MIN_S + ALERT_L2_PERSIST_S;
    expect(tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9))).toMatchObject({ level: 1 });
    for (let s = ALERT_L1_SPEEDING_MIN_S + 1; s < escalateAtS; s += 1) {
      expect(tick(s, speedingRow(s, OVER_9))).toBeNull();
    }
    expect(tick(escalateAtS, speedingRow(escalateAtS, OVER_9))).toMatchObject({
      level: 2,
      kind: 'speeding',
    });
  });

  test('a band increase re-alerts immediately, without waiting for ALERT_REALERT_S', () => {
    const { tick } = harness();
    expect(tick(5, speedingRow(5, OVER_9))).toMatchObject({ level: 1 });
    expect(tick(6, speedingRow(6, OVER_16))).toMatchObject({ level: 2 });
  });

  test('L3 once ALERT_L3_OVER_MPS has held for ALERT_L3_MIN_S, voiced "slow down"', () => {
    const { tick } = harness();
    // 21 over is ≥ the L2 threshold from the first alertable row, so the episode opens at L2 at
    // second 5; the L3 clock started at second 0, with the first row this far over.
    for (let s = 0; s < ALERT_L1_SPEEDING_MIN_S; s += 1) {
      expect(tick(s, speedingRow(s, OVER_21))).toBeNull();
    }
    expect(tick(5, speedingRow(5, OVER_21))).toMatchObject({ level: 2 });
    for (let s = 6; s < CONSTANTS.ALERT_L3_MIN_S; s += 1) {
      expect(tick(s, speedingRow(s, OVER_21))).toBeNull();
    }
    expect(tick(CONSTANTS.ALERT_L3_MIN_S, speedingRow(CONSTANTS.ALERT_L3_MIN_S, OVER_21))).toMatchObject({
      level: 3,
      kind: 'speeding',
      voice: 'alert.slowDown',
    });
  });

  test('re-alerts at the same band only after ALERT_REALERT_S, still over', () => {
    const { tick } = harness();
    const escalateAtS = ALERT_L1_SPEEDING_MIN_S + ALERT_L2_PERSIST_S;
    tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9));
    expect(tick(escalateAtS, speedingRow(escalateAtS, OVER_9))).toMatchObject({ level: 2 });
    const realertAtS = escalateAtS + ALERT_REALERT_S;
    expect(tick(realertAtS - 1, speedingRow(realertAtS - 1, OVER_9))).toBeNull();
    expect(tick(realertAtS, speedingRow(realertAtS, OVER_9))).toMatchObject({
      level: 2,
      kind: 'speeding',
    });
  });

  test('the episode resets after overMps returns to 0 for ALERT_SPEEDING_RESET_S', () => {
    const { tick } = harness();
    expect(tick(5, speedingRow(5, OVER_9))).toMatchObject({ level: 1 });
    tick(6, { overMps: 0, overForS: 0 });
    tick(6 + ALERT_SPEEDING_RESET_S, { overMps: 0, overForS: 0 });
    // A fresh episode: five seconds over is an L1 again, long before ALERT_REALERT_S.
    const restartS = 7 + ALERT_SPEEDING_RESET_S;
    expect(
      tick(restartS + ALERT_L1_SPEEDING_MIN_S, speedingRow(restartS + ALERT_L1_SPEEDING_MIN_S, OVER_9, restartS))
    ).toMatchObject({ level: 1, kind: 'speeding' });
  });

  test('a shorter dip below the limit does not reset the episode', () => {
    const { tick } = harness();
    expect(tick(5, speedingRow(5, OVER_9))).toMatchObject({ level: 1 });
    tick(6, { overMps: 0, overForS: 0 });
    // Back over before ALERT_SPEEDING_RESET_S elapsed: same episode, so no second L1.
    for (let s = 7; s < 7 + ALERT_L1_SPEEDING_MIN_S + 2; s += 1) {
      expect(tick(s, speedingRow(s, OVER_9, 6))).toBeNull();
    }
  });
});

describe('rule 3: phone handling', () => {
  const HANDLING = { id: 'p1', durationS: CONSTANTS.PHONE_HANDLING_MIN_S };

  test('L2 once the episode reaches PHONE_HANDLING_MIN_S above PHONE_MIN_SPEED_MPS', () => {
    const { tick } = harness();
    expect(tick(0, { phoneEpisode: { id: 'p1', durationS: 2 } })).toBeNull();
    expect(tick(1, { phoneEpisode: HANDLING })).toMatchObject({
      level: 2,
      kind: 'phone',
      voice: 'alert.phoneDown',
      eventId: 'p1',
      ts: at(1),
    });
  });

  test('stays silent below PHONE_MIN_SPEED_MPS', () => {
    const { tick } = harness();
    expect(
      tick(0, { phoneEpisode: HANDLING, speedMps: CONSTANTS.PHONE_MIN_SPEED_MPS - 0.01 })
    ).toBeNull();
    expect(tick(1, { phoneEpisode: HANDLING, speedMps: CONSTANTS.PHONE_MIN_SPEED_MPS })).toMatchObject({
      level: 2,
      kind: 'phone',
    });
  });

  test('once per episode, however long the handling goes on', () => {
    const { tick } = harness();
    expect(tick(0, { phoneEpisode: HANDLING })).toMatchObject({ kind: 'phone' });
    for (let s = 1; s < 10; s += 1) {
      expect(tick(s, { phoneEpisode: { id: 'p1', durationS: 3 + s } })).toBeNull();
    }
  });

  test('a new episode waits out ALERT_PHONE_COOLDOWN_S, then still alerts', () => {
    const { tick } = harness();
    const cooldown = CONSTANTS.ALERT_PHONE_COOLDOWN_S;
    expect(tick(0, { phoneEpisode: HANDLING })).toMatchObject({ kind: 'phone' });
    // A second pick-up inside the cooldown is silent — and is not burnt by it.
    expect(tick(cooldown - 1, { phoneEpisode: { id: 'p2', durationS: 3 } })).toBeNull();
    expect(tick(cooldown, { phoneEpisode: { id: 'p2', durationS: 4 } })).toMatchObject({
      level: 2,
      kind: 'phone',
      eventId: 'p2',
    });
  });
});

describe('rule 4: eyes off the road', () => {
  test('L2 once the glance reaches EYES_OFF_S above EYES_OFF_MIN_SPEED_MPS', () => {
    const { tick } = harness();
    expect(tick(0, { eyesOffS: CONSTANTS.EYES_OFF_S - 0.1 })).toBeNull();
    expect(tick(1, { eyesOffS: CONSTANTS.EYES_OFF_S })).toMatchObject({
      level: 2,
      kind: 'eyes_off',
      voice: 'alert.eyesUp',
    });
  });

  test('stays silent below EYES_OFF_MIN_SPEED_MPS — a shoulder check at a crawl is good driving', () => {
    const { tick } = harness();
    expect(
      tick(0, { eyesOffS: 4, speedMps: CONSTANTS.EYES_OFF_MIN_SPEED_MPS - 0.01 })
    ).toBeNull();
  });

  test('once per continuous glance', () => {
    const { tick } = harness();
    expect(tick(0, { eyesOffS: 2 })).toMatchObject({ kind: 'eyes_off' });
    expect(tick(1, { eyesOffS: 3 })).toBeNull();
    expect(tick(2, { eyesOffS: 4 })).toBeNull();
  });

  test('re-arms only once the eyes are back for ALERT_EYES_OFF_REARM_S', () => {
    const { tick } = harness();
    expect(tick(0, { eyesOffS: 2 })).toMatchObject({ kind: 'eyes_off' });
    // Still counted as away: no re-arm at exactly the re-arm threshold.
    tick(1, { eyesOffS: CONSTANTS.ALERT_EYES_OFF_REARM_S });
    expect(tick(2, { eyesOffS: 2 })).toBeNull();
    tick(3, { eyesOffS: 0 });
    expect(tick(4, { eyesOffS: 2 })).toMatchObject({ level: 2, kind: 'eyes_off' });
  });
});

describe('rule 5: drowsiness', () => {
  test('L3 that suggests a break, at most once per ALERT_DROWSY_MAX_PER_S', () => {
    const { tick } = harness();
    expect(tick(0, { drowsy: true })).toMatchObject({
      level: 3,
      kind: 'drowsy',
      voice: 'alert.takeABreak',
    });
    expect(tick(CONSTANTS.ALERT_DROWSY_MAX_PER_S - 1, { drowsy: true })).toBeNull();
    expect(tick(CONSTANTS.ALERT_DROWSY_MAX_PER_S, { drowsy: true })).toMatchObject({
      level: 3,
      kind: 'drowsy',
    });
  });

  test('silent when the flag is absent or false', () => {
    const { tick } = harness();
    expect(tick(0)).toBeNull();
    expect(tick(1, { drowsy: false })).toBeNull();
  });
});

describe('rule 6: break suggestion', () => {
  test('L1 once ALERT_BREAK_AFTER_S of driving, once per trip', () => {
    const { tick } = harness();
    expect(tick(0, { drivingS: CONSTANTS.ALERT_BREAK_AFTER_S - 1 })).toBeNull();
    expect(tick(1, { drivingS: CONSTANTS.ALERT_BREAK_AFTER_S })).toMatchObject({
      level: 1,
      kind: 'break',
      voice: 'alert.takeABreak',
    });
    expect(tick(2, { drivingS: CONSTANTS.ALERT_BREAK_AFTER_S + 1 })).toBeNull();
    expect(tick(3600, { drivingS: CONSTANTS.ALERT_BREAK_AFTER_S + 3599 })).toBeNull();
  });
});

describe('rule 9b: priority when several rules fire on one row', () => {
  const OVER_21 = mph(21);
  /** Everything wrong at once, on a row where the L3 clock has already run. */
  const EVERYTHING = {
    phoneEpisode: { id: 'p1', durationS: 5 },
    eyesOffS: 3,
    drowsy: true,
    drivingS: CONSTANTS.ALERT_BREAK_AFTER_S,
  };

  test('drowsy L3 > speeding L3 > phone L2 > eyes-off L2 > break L1, one per row', () => {
    const { tick } = harness();
    // Ten quiet-ish seconds well over the limit, held below the quality gate so only the L3
    // clock advances.
    for (let s = 0; s < CONSTANTS.ALERT_L3_MIN_S; s += 1) {
      expect(tick(s, { ...speedingRow(s, OVER_21), q: Q_FULL_AT - 0.01 })).toBeNull();
    }
    const row = (s: number) => ({ ...speedingRow(s, OVER_21), ...EVERYTHING });
    expect(tick(10, row(10))).toMatchObject({ level: 3, kind: 'drowsy' });
    expect(tick(11, row(11))).toMatchObject({ level: 3, kind: 'speeding' });
    expect(tick(12, row(12))).toMatchObject({ level: 2, kind: 'phone' });
    expect(tick(13, row(13))).toMatchObject({ level: 2, kind: 'eyes_off' });
    expect(tick(14, row(14))).toMatchObject({ level: 1, kind: 'break' });
    expect(tick(15, row(15))).toBeNull();
  });

  test('a rule that loses a row is still pending on the next one', () => {
    const { tick } = harness();
    // Speeding L1 outranks the break suggestion; the break is not lost, only deferred.
    expect(
      tick(ALERT_L1_SPEEDING_MIN_S, {
        ...speedingRow(ALERT_L1_SPEEDING_MIN_S, mph(9)),
        drivingS: CONSTANTS.ALERT_BREAK_AFTER_S,
      })
    ).toMatchObject({ level: 1, kind: 'speeding' });
    expect(
      tick(ALERT_L1_SPEEDING_MIN_S + 1, {
        ...speedingRow(ALERT_L1_SPEEDING_MIN_S + 1, mph(9)),
        drivingS: CONSTANTS.ALERT_BREAK_AFTER_S + 1,
      })
    ).toMatchObject({ level: 1, kind: 'break' });
  });

  test('phone L2 outranks speeding L2', () => {
    const { tick } = harness();
    const escalateAtS = ALERT_L1_SPEEDING_MIN_S + ALERT_L2_PERSIST_S;
    tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, mph(9)));
    expect(
      tick(escalateAtS, {
        ...speedingRow(escalateAtS, mph(9)),
        phoneEpisode: { id: 'p1', durationS: 3 },
      })
    ).toMatchObject({ level: 2, kind: 'phone' });
    expect(tick(escalateAtS + 1, speedingRow(escalateAtS + 1, mph(9)))).toMatchObject({
      level: 2,
      kind: 'speeding',
    });
  });
});

/**
 * One complete L1 speeding episode: over the limit long enough to alert, then back under long
 * enough to reset. Occupies seconds `startS`..`startS + 8`, so bursts sit 9 s apart.
 */
function l1Burst(tick: ReturnType<typeof harness>['tick'], startS: number) {
  const alertAtS = startS + ALERT_L1_SPEEDING_MIN_S;
  const decision = tick(alertAtS, speedingRow(alertAtS, mph(9), startS));
  tick(startS + 6, { overMps: 0, overForS: 0 });
  tick(startS + 6 + ALERT_SPEEDING_RESET_S, { overMps: 0, overForS: 0 });
  return decision;
}
const BURST_S = 9;

describe('rule 7: L1 budget', () => {
  test('spends ALERT_BUDGET_L1_PER_10MIN, then logs the rest as suppressed', () => {
    const { arbiter, tick } = harness();
    expect(arbiter.budgetRemaining(at(0))).toBe(CONSTANTS.ALERT_BUDGET_L1_PER_10MIN);
    for (let i = 0; i < CONSTANTS.ALERT_BUDGET_L1_PER_10MIN; i += 1) {
      expect(l1Burst(tick, i * BURST_S)).toMatchObject({ level: 1, kind: 'speeding' });
      expect(arbiter.budgetRemaining(at(i * BURST_S + ALERT_L1_SPEEDING_MIN_S))).toBe(
        CONSTANTS.ALERT_BUDGET_L1_PER_10MIN - (i + 1)
      );
    }
    const spentAtS = CONSTANTS.ALERT_BUDGET_L1_PER_10MIN * BURST_S;
    expect(l1Burst(tick, spentAtS)).toBeNull();

    const log = arbiter.log();
    expect(log).toHaveLength(CONSTANTS.ALERT_BUDGET_L1_PER_10MIN + 1);
    expect(log[log.length - 1]).toMatchObject({
      level: 1,
      kind: 'speeding',
      suppressed: true,
      ts: at(spentAtS + ALERT_L1_SPEEDING_MIN_S),
    });
    expect(log.filter((d) => d.suppressed === true)).toHaveLength(1);
  });

  test('the window rolls: the oldest L1 frees its slot after ALERT_BUDGET_WINDOW_S', () => {
    const { arbiter, tick } = harness();
    for (let i = 0; i < CONSTANTS.ALERT_BUDGET_L1_PER_10MIN; i += 1) l1Burst(tick, i * BURST_S);
    const firstAlertS = ALERT_L1_SPEEDING_MIN_S;
    const windowS = CONSTANTS.ALERT_BUDGET_WINDOW_S;
    expect(arbiter.budgetRemaining(at(firstAlertS + windowS - 1))).toBe(0);
    expect(arbiter.budgetRemaining(at(firstAlertS + windowS))).toBe(1);
  });

  test('L2 and L3 are never budget-suppressed', () => {
    const { arbiter, tick } = harness();
    for (let i = 0; i < CONSTANTS.ALERT_BUDGET_L1_PER_10MIN; i += 1) l1Burst(tick, i * BURST_S);
    const afterS = CONSTANTS.ALERT_BUDGET_L1_PER_10MIN * BURST_S;
    expect(arbiter.budgetRemaining(at(afterS))).toBe(0);
    expect(tick(afterS, { phoneEpisode: { id: 'p1', durationS: 3 } })).toMatchObject({
      level: 2,
      kind: 'phone',
    });
    expect(tick(afterS + 1, { drowsy: true })).toMatchObject({ level: 3, kind: 'drowsy' });
    expect(arbiter.log().filter((d) => d.suppressed === true)).toHaveLength(0);
  });

  test('a suppressed alert still spends its rule, so it is not retried every second', () => {
    const { arbiter, tick } = harness({ tripIndex: 0 });
    for (let i = 0; i < CONSTANTS.ALERT_BUDGET_L1_PER_10MIN; i += 1) l1Burst(tick, i * BURST_S);
    const afterS = CONSTANTS.ALERT_BUDGET_L1_PER_10MIN * BURST_S;
    expect(tick(afterS, { phoneEpisode: { id: 'p1', durationS: 3 } })).toBeNull();
    expect(tick(afterS + 1, { phoneEpisode: { id: 'p1', durationS: 4 } })).toBeNull();
    expect(arbiter.log().filter((d) => d.kind === 'phone')).toHaveLength(1);
  });
});

describe('rule 8: learning period', () => {
  const OVER_21 = mph(21);

  test('L2 becomes L1 while tripIndex < LEARNING_PERIOD_TRIPS, keeping kind and voice', () => {
    const { tick } = harness({ tripIndex: CONSTANTS.LEARNING_PERIOD_TRIPS - 1 });
    expect(tick(0, { phoneEpisode: { id: 'p1', durationS: 3 } })).toMatchObject({
      level: 1,
      kind: 'phone',
      voice: 'alert.phoneDown',
    });
    expect(tick(1, { eyesOffS: 2 })).toMatchObject({ level: 1, kind: 'eyes_off' });
  });

  test('speeding L3 becomes L1 too', () => {
    const { tick } = harness({ tripIndex: 0 });
    for (let s = 0; s < CONSTANTS.ALERT_L3_MIN_S; s += 1) {
      tick(s, { ...speedingRow(s, OVER_21), q: Q_FULL_AT - 0.01 });
    }
    expect(tick(10, speedingRow(10, OVER_21))).toMatchObject({
      level: 1,
      kind: 'speeding',
      voice: 'alert.slowDown',
    });
  });

  test('drowsiness stays L3 - safety is not softened for a new driver', () => {
    const { tick } = harness({ tripIndex: 0 });
    expect(tick(0, { drowsy: true })).toMatchObject({ level: 3, kind: 'drowsy' });
  });

  test('the fourth trip is no longer in the learning period', () => {
    const { tick } = harness({ tripIndex: CONSTANTS.LEARNING_PERIOD_TRIPS });
    expect(tick(0, { phoneEpisode: { id: 'p1', durationS: 3 } })).toMatchObject({ level: 2 });
  });
});

describe('rule 9a: mute', () => {
  const OVER_9 = mph(9);
  const OVER_21 = mph(21);
  const escalateAtS = ALERT_L1_SPEEDING_MIN_S + ALERT_L2_PERSIST_S;

  /** Drives an episode up to its L2 escalation and mutes it a second later. */
  function mutedAtL2(h: ReturnType<typeof harness>) {
    h.tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9));
    expect(h.tick(escalateAtS, speedingRow(escalateAtS, OVER_9))).toMatchObject({ level: 2 });
    h.arbiter.mute(at(escalateAtS + 1));
  }

  test('stops the repeat that ALERT_REALERT_S would otherwise bring', () => {
    const h = harness();
    mutedAtL2(h);
    const realertAtS = escalateAtS + ALERT_REALERT_S;
    expect(h.tick(realertAtS, speedingRow(realertAtS, OVER_9))).toBeNull();
    expect(h.tick(realertAtS + 1, speedingRow(realertAtS + 1, OVER_9))).toBeNull();
  });

  test('a band increase still speaks through the mute', () => {
    const h = harness();
    mutedAtL2(h);
    const worseFromS = escalateAtS + 5;
    for (let s = worseFromS; s < worseFromS + CONSTANTS.ALERT_L3_MIN_S; s += 1) {
      expect(h.tick(s, speedingRow(s, OVER_21))).toBeNull();
    }
    const l3AtS = worseFromS + CONSTANTS.ALERT_L3_MIN_S;
    expect(h.tick(l3AtS, speedingRow(l3AtS, OVER_21))).toMatchObject({ level: 3, kind: 'speeding' });
  });

  test('a new episode speaks again', () => {
    const h = harness();
    mutedAtL2(h);
    h.tick(escalateAtS + 2, { overMps: 0, overForS: 0 });
    h.tick(escalateAtS + 2 + ALERT_SPEEDING_RESET_S, { overMps: 0, overForS: 0 });
    const restartS = escalateAtS + 3 + ALERT_SPEEDING_RESET_S;
    const alertAtS = restartS + ALERT_L1_SPEEDING_MIN_S;
    expect(h.tick(alertAtS, speedingRow(alertAtS, OVER_9, restartS))).toMatchObject({
      level: 1,
      kind: 'speeding',
    });
  });

  test('a long-press after the episode ended does not carry into the next one', () => {
    const h = harness();
    h.tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9));
    h.tick(6, { overMps: 0, overForS: 0 });
    h.tick(6 + ALERT_SPEEDING_RESET_S, { overMps: 0, overForS: 0 });
    h.arbiter.mute(at(20)); // nothing is speaking any more

    const restartS = 9;
    const l1AtS = restartS + ALERT_L1_SPEEDING_MIN_S;
    expect(h.tick(l1AtS, speedingRow(l1AtS, OVER_9, restartS))).toMatchObject({ level: 1 });
    const l2AtS = restartS + escalateAtS;
    expect(h.tick(l2AtS, speedingRow(l2AtS, OVER_9, restartS))).toMatchObject({ level: 2 });
    const realertAtS = l2AtS + ALERT_REALERT_S;
    expect(h.tick(realertAtS, speedingRow(realertAtS, OVER_9, restartS))).toMatchObject({
      level: 2,
      kind: 'speeding',
    });
  });

  test('mutes only the alert that is speaking, not the other rules', () => {
    const h = harness();
    mutedAtL2(h);
    expect(
      h.tick(escalateAtS + 2, {
        ...speedingRow(escalateAtS + 2, OVER_9),
        phoneEpisode: { id: 'p1', durationS: 3 },
      })
    ).toMatchObject({ level: 2, kind: 'phone' });
  });

  test('a mute carried in as state.mutedUntilTs holds until it expires', () => {
    const untilS = escalateAtS + ALERT_REALERT_S + 10;
    const h = harness({ mutedUntilTs: at(untilS) });
    h.tick(ALERT_L1_SPEEDING_MIN_S, speedingRow(ALERT_L1_SPEEDING_MIN_S, OVER_9));
    expect(h.tick(escalateAtS, speedingRow(escalateAtS, OVER_9))).toMatchObject({ level: 2 });
    const realertAtS = escalateAtS + ALERT_REALERT_S;
    expect(h.tick(realertAtS, speedingRow(realertAtS, OVER_9))).toBeNull();
    expect(h.tick(untilS, speedingRow(untilS, OVER_9))).toMatchObject({
      level: 2,
      kind: 'speeding',
    });
  });
});

describe('rule 10: voice keys', () => {
  test('every phrase is defined, and at most 3 words except the break suggestion', () => {
    expect(en['alert.easeOff']).toBe('Ease off');
    expect(en['alert.slowDown']).toBe('Slow down');
    expect(en['alert.phoneDown']).toBe('Phone down');
    expect(en['alert.eyesUp']).toBe('Eyes up');
    expect(en['alert.takeABreak']).toBe('Take a break soon');
    const inDrive = ['alert.easeOff', 'alert.slowDown', 'alert.phoneDown', 'alert.eyesUp'] as const;
    expect(inDrive.map((key) => en[key].split(' ').length)).toEqual([2, 2, 2, 2]);
  });

  test('every decision carries one of them', () => {
    const { arbiter, tick } = harness();
    tick(0, { drowsy: true });
    tick(1, { phoneEpisode: { id: 'p1', durationS: 3 } });
    tick(2, { eyesOffS: 2 });
    tick(3, { drivingS: CONSTANTS.ALERT_BREAK_AFTER_S });
    const speedAtS = 4 + ALERT_L1_SPEEDING_MIN_S;
    tick(speedAtS, speedingRow(speedAtS, mph(9), 4));
    expect(arbiter.log().map((d) => `${d.kind}:${d.voice ?? ''}`)).toEqual([
      'drowsy:alert.takeABreak',
      'phone:alert.phoneDown',
      'eyes_off:alert.eyesUp',
      'break:alert.takeABreak',
      'speeding:alert.easeOff',
    ]);
  });
});
