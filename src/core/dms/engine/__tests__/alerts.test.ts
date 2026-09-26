// The alert manager (plan §M8, Task 11): the tier state diagram, anti-annoyance rules 1–9 (positive and
// negative cases), priority with the 10 s defer/drop, Critical through LOST and its end on a KNOWN
// speed only (rev1 I6, T8 review m4), shadow mode, and `tagLastAlert`.
import { createAlertManager, type AlertFrame, type AlertRequest, type DmsAlertCommand } from '../alerts';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const FPS = 15;
const EPOCH0 = 1_700_000_000_000;

type Seg = { s: number; f?: Partial<AlertFrame>; req?: AlertRequest[] };

/** Runs segments at 15 fps; a segment's requests arrive on its first frame. Returns every command. */
function run(segs: Seg[], mode: 'live' | 'shadow' = 'live', am = createAlertManager(C, { mode })) {
  const cmds: DmsAlertCommand[] = [];
  let i = 0;
  for (const seg of segs) {
    const n = Math.max(1, Math.round(seg.s * FPS));
    for (let k = 0; k < n; k++, i++) {
      const tMs = (i * 1000) / FPS;
      const x: AlertFrame = {
        tMs,
        epochMs: EPOCH0 + tMs,
        ruleSpeedKmh: 60,
        speedKnown: true,
        quality: 'tracking',
        onRoad: true,
        eyesOpen: true,
        warmup: false,
        requests: k === 0 ? (seg.req ?? []) : [],
        ...seg.f,
      };
      cmds.push(...am.onFrame(x));
    }
  }
  return { cmds, am, sig: cmds.map((c) => `${c.action}:${c.kind}`) };
}
const off: Partial<AlertFrame> = { onRoad: false };
const asleep: Partial<AlertFrame> = { onRoad: false, eyesOpen: false };
/** A closure Critical (F1, F2, microsleep_nod): `bridged` is required by type (T11 review I2). */
const crit = (kind: 'microsleep' | 'sleep' | 'microsleep_nod', bridged = false): AlertRequest => ({ kind, bridged });
/**
 * `unresponsive`: closure (F3), no-on-road (F3's second clause) or D4; every flag required. The origin (C2,
 * rev4 §2.1.8) defaults to the sleep family for F3's closure clause and to D4 otherwise.
 */
const unr = (o: Partial<{ closure: boolean; bridged: boolean; c8: boolean; escalation: boolean; origin: 'sleep' | 'd4' }> = {}): AlertRequest => ({
  kind: 'unresponsive',
  closure: o.closure ?? false,
  bridged: o.bridged ?? false,
  c8: o.c8 ?? false,
  escalation: o.escalation ?? false,
  origin: o.origin ?? (o.closure === true ? 'sleep' : 'd4'),
});
const dist = (kind: 'distraction' | 'cumulative', c8 = false): AlertRequest => ({ kind, c8 });
const plain = (kind: 'phone_pattern' | 'fatigue_early' | 'fatigue' | 'repeated_glances'): AlertRequest => ({ kind });

describe('the state diagram (§M8)', () => {
  test('Tier 2 distraction: start off road, stop on the first on-road frame (rule 1); no stop while still off road', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 0.2 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.cmds[0]).toMatchObject({ tier: 2, id: 1, muted: false, epochMs: EPOCH0 });
    expect(r.cmds[1]!.tMs).toBeCloseTo(1000, 6); // the first on-road frame
    expect(run([{ s: 3, f: off, req: [dist('distraction')] }]).sig).toEqual(['start:distraction']);
  });
  test('Critical: continuous through LOST at speed; ends once the eyes are open AND on road for 1.0 s (not 0.9 s)', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('microsleep')] }, { s: 3, f: { ...asleep, quality: 'lost' } }, { s: 0.9 }, { s: 0.5, f: off }]);
    expect(r.sig).toEqual(['start:microsleep']);
    expect(r.cmds[0]!.tier).toBe(3);
    const done = run([{ s: 1, f: asleep, req: [crit('microsleep')] }, { s: 3, f: { ...asleep, quality: 'lost' } }, { s: 1.2 }]);
    expect(done.sig).toEqual(['start:microsleep', 'stop:microsleep']);
    expect(done.cmds[1]!.tMs - 4000).toBeGreaterThanOrEqual(1000 - 1e-6);
    expect(done.cmds[1]!.tMs - 4000).toBeLessThan(1000 + 67);
    // Open eyes looking away do not end it.
    expect(run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 3, f: off }]).sig).toEqual(['start:sleep']);
  });
  test('a Critical replaces a running Tier 2 distraction; a new Critical kind replaces the running one', () => {
    expect(run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 0.5, f: asleep, req: [unr()] }]).sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
    expect(run([{ s: 1, f: asleep, req: [crit('microsleep')] }, { s: 2, f: asleep, req: [crit('sleep')] }]).sig).toEqual(['start:microsleep', 'stop:microsleep', 'start:sleep']);
  });
});

describe('the Critical speed rules (rule 4, rev1 I6, T8 review m4; C2: they bind the D4 origin only)', () => {
  // C2 (rev4 §2.1.7, §2.1.8): the sleep family starts at any speed and no stop ends it; a D4-origin Critical
  // keeps the start gate (for a request that is not an escalation) and the end after 5 s stopped. A frame with
  // no `stopped` reads a KNOWN speed below 10 as stopped (the older callers).
  const warn = { s: 1, f: off, req: [dist('distraction')] };
  const d4 = (f: Partial<AlertFrame> = asleep) => ({ s: 1, f, req: [unr({ escalation: true, origin: 'd4' })] });
  const D4_SIG = ['start:distraction', 'stop:distraction', 'start:unresponsive'];
  test('a D4-origin request that is not an escalation may start at ≥ 10 km/h, not at 9 or with no speed', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 10 }, req: [unr({ origin: 'd4' })] }]).sig).toEqual(['start:unresponsive']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 9 }, req: [unr({ origin: 'd4' })] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [unr({ origin: 'd4' })] }]).sig).toEqual([]);
  });
  test('the sleep family starts at 9 km/h and with no speed at all (C2)', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 9 }, req: [crit('sleep')] }]).sig).toEqual(['start:sleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [crit('sleep')] }]).sig).toEqual(['start:sleep']);
  });
  test('a D4-origin Critical continues through a slowdown and ends only after a KNOWN speed < 10 km/h for 5 s', () => {
    const slow = (s: number) => run([warn, d4(), { s, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(slow(4.9).sig).toEqual(D4_SIG);
    expect(slow(5.1).sig).toEqual([...D4_SIG, 'stop:unresponsive']);
  });
  test('a sleep Critical does not end on a known speed < 10 km/h (C2)', () => {
    expect(run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 30, f: { ...asleep, ruleSpeedKmh: 5 } }]).sig).toEqual(['start:sleep']);
  });
  test('an unknown (or held, inferred) speed never ends a D4-origin Critical', () => {
    const r = run([warn, d4(), { s: 60, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false } }, { s: 30, f: { ...asleep, ruleSpeedKmh: 0, speedKnown: false } }]);
    expect(r.sig).toEqual(D4_SIG);
  });
  test('a known ≥ 10 km/h frame restarts the 5 s', () => {
    const r = run([warn, d4(), { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }, { s: 0.1, f: { ...asleep, ruleSpeedKmh: 12 } }, { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(r.sig).toEqual(D4_SIG);
  });
});

describe('priority and the 10 s defer/drop', () => {
  test('a fatigue burst held by a Tier 2 distraction plays once the distraction stops within 10 s', () => {
    const r = run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 3, f: off, req: [plain('fatigue')] }, { s: 0.2 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'once:fatigue']);
    expect(r.cmds[2]!.tier).toBe(2);
  });
  test('held past 10 s it is dropped (logged)', () => {
    const r = run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 10.5, f: off, req: [plain('fatigue')] }, { s: 1 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.am.stats().byKind.fatigue).toMatchObject({ dropped: 1, delivered: 0 });
  });
  test('Tier 1 waits behind a Critical and is dropped after 10 s; a distraction during a Critical is dropped at once', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 12, f: asleep, req: [plain('phone_pattern'), dist('distraction')] }, { s: 2 }]);
    expect(r.sig).toEqual(['start:sleep', 'stop:sleep']);
    expect(r.am.stats().byKind.phone_pattern!.dropped).toBe(1);
    expect(r.am.stats().byKind.distraction!.dropped).toBe(1);
  });
  test('the fatigue burst goes before a held Tier 1', () => {
    const r = run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 2, f: off, req: [plain('phone_pattern'), plain('fatigue')] }, { s: 0.5 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'once:fatigue', 'once:phone_pattern']);
  });
});

describe('anti-annoyance rules (§M8)', () => {
  test('rule 3: Tier 1 at most once per 10 min per type; another type is not blocked', () => {
    const r = run([{ s: 1, req: [plain('phone_pattern')] }, { s: 598, req: [plain('phone_pattern')] }, { s: 1, req: [plain('fatigue_early')] }, { s: 2, req: [plain('phone_pattern')] }]);
    expect(r.sig).toEqual(['once:phone_pattern', 'once:fatigue_early', 'once:phone_pattern']);
    expect(r.cmds.every((c) => c.tier === 1)).toBe(true);
    expect(r.am.stats().byKind.phone_pattern).toMatchObject({ delivered: 2, suppressed: 1 });
  });
  test('rule 4: nothing audible below 20 km/h (Tier 1 and 2); a running distraction stops when the speed falls below it', () => {
    expect(run([{ s: 1, f: { ...off, ruleSpeedKmh: 15 }, req: [dist('distraction'), plain('fatigue'), plain('phone_pattern')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...off, ruleSpeedKmh: 20 }, req: [dist('distraction')] }]).sig).toEqual(['start:distraction']);
    expect(run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: { ...off, ruleSpeedKmh: 15 } }]).sig).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('rule 5: no distraction alert from a LOST frame except C-8 (suppressed); a bridged closure Critical on LOST starts (C-26)', () => {
    expect(run([{ s: 1, f: { ...off, quality: 'lost' }, req: [dist('distraction')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...off, quality: 'lost' }, req: [dist('distraction', true)] }]).sig).toEqual(['start:distraction']);
    const r = run([{ s: 1, f: { ...asleep, quality: 'lost' }, req: [crit('sleep', true)] }]);
    expect(r.sig).toEqual(['start:sleep']);
    expect(r.am.stats().invariantViolations).toBe(0);
  });
  test('T11 review I2: a Tier 3 rule-5 mismatch (a façade bug) fails LOUD: delivered, logged rule5_violation, counted', () => {
    const r = run([{ s: 1, f: { ...asleep, quality: 'lost' }, req: [crit('sleep', false)] }]);
    expect(r.sig).toEqual(['start:sleep']);
    expect(r.am.stats().invariantViolations).toBe(1);
    expect(r.am.stats().log.at(-1)).toMatchObject({ kind: 'sleep', why: 'rule5_violation' });
    // A D4 after a real warning (so the escalation is corroborated, T11 round 2), raised on LOST without C-8.
    const d4 = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: { ...off, quality: 'lost' }, req: [unr({ c8: false, escalation: true })] }]);
    expect(d4.sig).toContain('start:unresponsive');
    expect(d4.am.stats().invariantViolations).toBe(1);
    expect(run([{ s: 1, f: { ...asleep, quality: 'head_only' }, req: [crit('microsleep')] }]).am.stats().invariantViolations).toBe(1);
  });
  test('rule 6: warm-up allows only Critical and D1', () => {
    const w: Partial<AlertFrame> = { ...off, warmup: true };
    expect(run([{ s: 1, f: w, req: [dist('cumulative'), plain('phone_pattern'), plain('fatigue'), plain('fatigue_early')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: w, req: [dist('distraction')] }]).sig).toEqual(['start:distraction']);
    expect(run([{ s: 1, f: { ...w, eyesOpen: false }, req: [crit('microsleep')] }]).sig).toEqual(['start:microsleep']);
    expect(run([{ s: 1, f: off, req: [dist('cumulative')] }]).sig).toEqual(['start:cumulative']);
  });
  test('rule 7: tagLastAlert("wrong") tags the last alert and changes nothing live', () => {
    const segs: Seg[] = [{ s: 1, f: off, req: [dist('distraction')] }, { s: 1 }, { s: 1, f: off, req: [dist('distraction')] }, { s: 1 }];
    const plain = run(segs);
    const am = createAlertManager(C, { mode: 'live' });
    const tagged: DmsAlertCommand[] = [];
    run(segs.slice(0, 2), 'live', am);
    expect(am.tagLastAlert('wrong')).toBe(true);
    const rest = run(segs.slice(2), 'live', am);
    tagged.push(...rest.cmds);
    expect(tagged.map((c) => `${c.action}:${c.kind}`)).toEqual(plain.sig.slice(2));
    const log = am.stats().log;
    expect(log.filter((e) => e.tag === 'wrong')).toHaveLength(1);
    expect(log.find((e) => e.tag === 'wrong')!.tMs).toBe(0);
    expect(createAlertManager(C, { mode: 'live' }).tagLastAlert('wrong')).toBe(false);
  });
  test('T11 review m2: rule 8 counts warnings the driver heard; a request merged into a running beep does not count', () => {
    const glance: Seg[] = [{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 0.5, f: off, req: [dist('cumulative')] }, { s: 1 }];
    const r = run([...glance, { s: 100 }, { s: 1, f: off, req: [dist('distraction')] }, { s: 1 }]);
    expect(r.sig).not.toContain('once:repeated_glances');
    expect(r.am.stats().byKind.cumulative.merged).toBe(1);
  });
  test('rule 8: three Tier 2 distraction warnings within 10 min → one Tier 1 repeated_glances plus an event flag, no louder tier', () => {
    const warn = (gapS: number): Seg[] => [{ s: 1, f: off, req: [dist('distraction')] }, { s: gapS }];
    const r = run([...warn(200), ...warn(200), ...warn(10)]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:distraction', 'stop:distraction', 'start:distraction', 'stop:distraction', 'once:repeated_glances']);
    expect(r.cmds.at(-1)!.tier).toBe(1);
    expect(r.cmds.filter((c) => c.kind === 'distraction').every((c) => c.tier === 2)).toBe(true);
    expect(r.am.stats().log.find((e) => e.kind === 'repeated_glances')!.flag).toBe(true);
    // Spread over more than 10 min: none.
    expect(run([...warn(310), ...warn(310), ...warn(10)]).sig).not.toContain('once:repeated_glances');
  });
  test('rules 2 and 9 are enforced upstream: D1 re-arms at f ≥ 0.5 and sensitivity scales B (attention.ts, Task 8 tests)', () => {
    // The manager plays what the rules raise; it never re-arms or scales on its own. A second D1 request
    // while one is running is merged, not a second start.
    expect(run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 0.5, f: off, req: [dist('distraction')] }]).sig).toEqual(['start:distraction']);
  });
});

describe('shadow mode', () => {
  test('everything is decided the same, and every command is muted', () => {
    const segs: Seg[] = [{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 0.5, f: asleep, req: [unr()] }, { s: 2 }, { s: 1, req: [plain('phone_pattern')] }];
    const live = run(segs);
    const shadow = run(segs, 'shadow');
    expect(shadow.sig).toEqual(live.sig);
    expect(shadow.cmds.every((c) => c.muted)).toBe(true);
    expect(live.cmds.every((c) => !c.muted)).toBe(true);
    expect(shadow.am.stats().byKind.phone_pattern).toMatchObject({ muted: 1, delivered: 0 });
  });
});

describe('T11 review I1: escalations skip the Critical start gate', () => {
  test('D4 after a D1 warning at 25 km/h fires at a known 8 km/h', () => {
    const r = run([{ s: 1, f: { ...off, ruleSpeedKmh: 25 }, req: [dist('distraction')] }, { s: 1, f: { ...off, ruleSpeedKmh: 8 }, req: [unr({ escalation: true })] }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
  });
  test('…and at an unknown speed', () => {
    const r = run([{ s: 1, f: { ...off, ruleSpeedKmh: 25 }, req: [dist('distraction')] }, { s: 1, f: { ...off, ruleSpeedKmh: null, speedKnown: false }, req: [unr({ escalation: true })] }]);
    expect(r.sig).toContain('start:unresponsive');
  });
  test('C2: a fresh microsleep at 8 km/h starts (the sleep family is exempt); a fresh D4 request that is not an escalation is suppressed', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 8 }, req: [crit('microsleep')] }]).sig).toEqual(['start:microsleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 8 }, req: [unr({ origin: 'd4' })] }]).sig).toEqual([]);
  });
  test('sleep running, then F3 (an escalation) at an unknown speed replaces it', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [unr({ closure: true, escalation: true })] }]);
    expect(r.sig).toEqual(['start:sleep', 'stop:sleep', 'start:unresponsive']);
  });
});

describe('T11 review m1: stopAll, and ticking without the camera', () => {
  test('stopAll stops a running Critical once, drops held items (session_end) and resets', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 1, f: asleep, req: [plain('fatigue')] }]);
    const stops = r.am.stopAll(2000, EPOCH0 + 2000);
    expect(stops.map((c) => `${c.action}:${c.kind}`)).toEqual(['stop:sleep']);
    expect(stops[0]).toMatchObject({ tier: 3, tMs: 2000, epochMs: EPOCH0 + 2000 });
    expect(r.am.stats().log.at(-1)).toMatchObject({ kind: 'fatigue', outcome: 'dropped', why: 'session_end' });
    expect(r.am.stopAll(3000, EPOCH0 + 3000)).toEqual([]);
  });
  test('frames at 1 Hz with quality lost and a known 5 km/h end a D4-origin Critical after 5 s (C2: a sleep one never)', () => {
    const am = createAlertManager(C, { mode: 'live' });
    run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: asleep, req: [unr({ escalation: true, origin: 'd4' })] }], 'live', am);
    const out: string[] = [];
    for (let k = 1; k <= 7; k++) {
      const tMs = 2000 + k * 1000;
      out.push(...am.onFrame({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 5, speedKnown: true, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [] }).map((c) => `${c.action}:${c.kind}@${c.tMs}`));
    }
    expect(out).toEqual(['stop:unresponsive@8000']);
    const sleepAm = createAlertManager(C, { mode: 'live' });
    run([{ s: 1, f: asleep, req: [crit('sleep')] }], 'live', sleepAm);
    const none: string[] = [];
    for (let k = 1; k <= 7; k++) {
      const tMs = 1000 + k * 1000;
      none.push(...sleepAm.onFrame({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 5, speedKnown: true, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [] }).map((c) => c.action));
    }
    expect(none).toEqual([]);
  });
});

describe('T11 review nit', () => {
  test('an idle frame allocates nothing: the same frozen empty array', () => {
    const am = createAlertManager(C, { mode: 'live' });
    const idle = { tMs: 0, epochMs: 0, ruleSpeedKmh: 60, speedKnown: true, quality: 'tracking' as const, onRoad: true, eyesOpen: true, warmup: false, requests: [] };
    const a = am.onFrame(idle);
    const b = am.onFrame({ ...idle, tMs: 67 });
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('T11 round 2 (R1-m1): an escalation is corroborated, or fails loud', () => {
  test('a D1 request, then an escalation at 8 km/h → delivered, 0 violations', () => {
    const r = run([{ s: 1, f: { ...off, ruleSpeedKmh: 25 }, req: [dist('distraction')] }, { s: 1, f: { ...off, ruleSpeedKmh: 8 }, req: [unr({ escalation: true })] }]);
    expect(r.sig).toContain('start:unresponsive');
    expect(r.am.stats().invariantViolations).toBe(0);
  });
  test('an escalation with no prior warning and no running Critical → still delivered, logged escalation_unverified, 1 violation', () => {
    const r = run([{ s: 1, f: { ...off, ruleSpeedKmh: 8 }, req: [unr({ escalation: true })] }]);
    expect(r.sig).toEqual(['start:unresponsive']);
    expect(r.am.stats().invariantViolations).toBe(1);
    expect(r.am.stats().log.at(-1)).toMatchObject({ kind: 'unresponsive', why: 'escalation_unverified' });
  });
  test('a warning, then an on-road frame, then an escalation → 1 violation; a known < 10 km/h for 5 s clears it too', () => {
    const onRoadBetween = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 0.1 }, { s: 1, f: off, req: [unr({ escalation: true })] }]);
    expect(onRoadBetween.am.stats().invariantViolations).toBe(1);
    const slowBetween = run([{ s: 1, f: { ...off, ruleSpeedKmh: 25 }, req: [dist('distraction')] }, { s: 5.2, f: { ...off, ruleSpeedKmh: 5 } }, { s: 1, f: { ...off, ruleSpeedKmh: 5 }, req: [unr({ escalation: true })] }]);
    expect(slowBetween.am.stats().invariantViolations).toBe(1);
    const running = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [unr({ closure: true, escalation: true })] }]);
    expect(running.am.stats().invariantViolations).toBe(0);
  });
});

describe('T12: critical() reports the running Critical (the façade ends the F3 watch with it)', () => {
  test('null, then the kind while it runs, then null after its stop', () => {
    const am = createAlertManager(C, { mode: 'live' });
    expect(am.critical()).toBeNull();
    run([{ s: 1, f: asleep, req: [crit('sleep')] }], 'live', am);
    expect(am.critical()).toBe('sleep');
    run([{ s: 1.2 }], 'live', am);
    expect(am.critical()).toBeNull();
  });
});

describe('T12 review m2: the log records the request frame\u2019s quality (rule 5 at request time)', () => {
  test('each logged request carries its frame quality and, for D1/D2 and D4, its c8', () => {
    const r = run([{ s: 1, f: { ...off, quality: 'lost' }, req: [dist('distraction', true)] }, { s: 0.1 }, { s: 1, f: { ...off, quality: 'head_only' }, req: [plain('phone_pattern')] }]);
    const log = r.am.stats().log;
    expect(log[0]).toMatchObject({ kind: 'distraction', quality: 'lost', c8: true });
    expect(log[1]).toMatchObject({ kind: 'phone_pattern', quality: 'head_only' });
  });
});

describe('T13 r1 I1: cameraOff keeps a Critical (the phone overheating says nothing about the driver)', () => {
  const blind = (tMs: number, speed: number | null = 60, speedKnown = true): AlertFrame => ({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: speed, speedKnown, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [], blind: true, blindSinceMs: 1000 }); // the last frame: when the camera went off
  test('a running distraction stops (camera_off); a held Tier 1 is dropped', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction'), plain('phone_pattern')] }]);
    const cmds = r.am.cameraOff(1000, EPOCH0 + 1000, 'heat');
    expect(cmds.map((c) => `${c.action}:${c.kind}`)).toEqual(['stop:distraction']);
    const log = r.am.stats().log;
    expect(log.find((e) => e.kind === 'distraction' && e.why === 'camera_off')).toBeDefined();
    expect(log.find((e) => e.kind === 'phone_pattern' && e.outcome === 'dropped' && e.why === 'camera_off')).toBeDefined();
  });
  test('a running Critical is kept: at a known 60 km/h it still sounds at 59 s blind, and at 60 s it stops (blind_cap) with one Tier 1 monitoring_paused', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }]);
    expect(r.am.cameraOff(1000, EPOCH0 + 1000, 'heat')).toEqual([]);
    const out: DmsAlertCommand[] = [];
    for (let k = 1; k <= 59; k++) out.push(...r.am.onFrame(blind(1000 + k * 1000)));
    expect(out).toEqual([]);
    expect(r.am.critical()).toBe('sleep');
    out.push(...r.am.onFrame(blind(61_000)));
    expect(out.map((c) => `${c.action}:${c.kind}:${c.tier}`)).toEqual(['stop:sleep:3', 'once:monitoring_paused:1']);
    expect(out[1]!.cause).toBe('heat');
    expect(r.am.stats().log.find((e) => e.kind === 'sleep' && e.why === 'blind_cap')).toBeDefined();
  });
  test('a known 5 km/h for 5 s still ends a D4-origin Critical (no monitoring_paused); C2: a sleep one runs on', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: asleep, req: [unr({ escalation: true, origin: 'd4' })] }]);
    r.am.cameraOff(2000, EPOCH0 + 2000, 'dark');
    const out: DmsAlertCommand[] = [];
    for (let k = 1; k <= 7; k++) out.push(...r.am.onFrame(blind(2000 + k * 1000, 5)));
    expect(out.map((c) => `${c.action}:${c.kind}`)).toEqual(['stop:unresponsive']);
    const s2 = run([{ s: 1, f: asleep, req: [crit('sleep')] }]);
    s2.am.cameraOff(1000, EPOCH0 + 1000, 'dark');
    const none: DmsAlertCommand[] = [];
    for (let k = 1; k <= 7; k++) none.push(...s2.am.onFrame(blind(1000 + k * 1000, 5)));
    expect(none).toEqual([]);
  });
  test('frames returning clear the blind clock', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }]);
    r.am.cameraOff(1000, EPOCH0 + 1000, 'heat');
    for (let k = 1; k <= 30; k++) r.am.onFrame(blind(1000 + k * 1000));
    r.am.onFrame({ ...blind(31_500), blind: false, quality: 'tracking' }); // the camera is back
    const out: DmsAlertCommand[] = [];
    for (let k = 32; k <= 95; k++) out.push(...r.am.onFrame({ ...blind(k * 1000), blind: false, quality: 'tracking' }));
    expect(out.map((c) => c.kind)).not.toContain('monitoring_paused');
    expect(r.am.critical()).toBe('sleep');
  });
});

describe('T13 r1 nit: monitoring_paused is a Tier 1 (rule 3: once per tier1EveryS), and the one rule-4 exception', () => {
  const blindAt = (tMs: number, since = 0): AlertFrame => ({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 15, speedKnown: true, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [], blind: true, blindSinceMs: since });
  const live = (tMs: number, requests: AlertRequest[] = []): AlertFrame => ({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 60, speedKnown: true, quality: 'tracking', onRoad: false, eyesOpen: false, warmup: false, requests });
  /** A Critical at `t0`, the camera off at once, then 61 s blind at a known 15 km/h. */
  function blindCap(am: ReturnType<typeof createAlertManager>, t0: number): DmsAlertCommand[] {
    const out: DmsAlertCommand[] = [...am.onFrame(live(t0, [crit('sleep')]))];
    out.push(...am.cameraOff(t0, EPOCH0 + t0, 'heat'));
    for (let k = 1; k <= 61; k++) out.push(...am.onFrame(blindAt(t0 + k * 1000, t0)));
    return out;
  }
  test('at 15 km/h (below rule 4’s 20) the first blind cap still says why the sound stopped', () => {
    const am = createAlertManager(C, { mode: 'live' });
    expect(blindCap(am, 0).map((c) => `${c.action}:${c.kind}`)).toEqual(['start:sleep', 'stop:sleep', 'once:monitoring_paused']);
  });
  test('a second blind cap within 10 min: the Critical stops, monitoring_paused is suppressed (tier1_rate)', () => {
    const am = createAlertManager(C, { mode: 'live' });
    blindCap(am, 0);
    const second = blindCap(am, 120_000);
    expect(second.map((c) => `${c.action}:${c.kind}`)).toEqual(['start:sleep', 'stop:sleep']);
    expect(am.stats().log.filter((e) => e.kind === 'monitoring_paused').map((e) => `${e.outcome}:${e.why ?? ''}`)).toEqual(['delivered:', 'suppressed:tier1_rate']);
  });
  test('after 10 min it is delivered again', () => {
    const am = createAlertManager(C, { mode: 'live' });
    blindCap(am, 0);
    const later = blindCap(am, 61_000 + C.alerts.tier1EveryS * 1000);
    expect(later.map((c) => c.kind)).toContain('monitoring_paused');
  });
});

describe('final review: the alert manager', () => {
  test('I4: violations() is the counter stats() reports, read without a copy', () => {
    const r = run([{ s: 1, f: { ...asleep, quality: 'head_only' }, req: [crit('sleep', false)] }]);
    expect(r.am.violations()).toBe(1);
    expect(r.am.violations()).toBe(r.am.stats().invariantViolations);
  });
  test('m4: a microsleep_nod raised on a HEAD_ONLY recovery frame is not a rule-5 violation (still one on LOST unbridged)', () => {
    const ho = run([{ s: 1, f: { ...asleep, quality: 'head_only' }, req: [crit('microsleep_nod', false)] }]);
    expect(ho.sig).toEqual(['start:microsleep_nod']);
    expect(ho.am.violations()).toBe(0);
    const lost = run([{ s: 1, f: { ...asleep, quality: 'lost' }, req: [crit('microsleep_nod', false)] }]);
    expect(lost.am.violations()).toBe(1);
  });
  test('m5: stopAll clears the escalation corroboration (a later D4 is not corroborated by a stopped warning)', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }]);
    r.am.stopAll(1000, EPOCH0 + 1000);
    r.am.onFrame({ tMs: 1100, epochMs: EPOCH0 + 1100, ruleSpeedKmh: 60, speedKnown: true, quality: 'tracking', onRoad: false, eyesOpen: true, warmup: false, requests: [unr({ escalation: true })] });
    expect(r.am.stats().log.at(-1)).toMatchObject({ kind: 'unresponsive', why: 'escalation_unverified' });
  });
  test('m9: the clear condition is not measured across a frame gap', () => {
    const am = createAlertManager(C, { mode: 'live' });
    const fr = (tMs: number, o: Partial<AlertFrame> = {}): AlertFrame => ({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 60, speedKnown: true, quality: 'tracking', onRoad: true, eyesOpen: true, warmup: false, requests: [], ...o });
    am.onFrame(fr(0, { onRoad: false, eyesOpen: false, requests: [crit('sleep')] }));
    am.onFrame(fr(100)); // clear
    const out = am.onFrame(fr(1600, { gap: true })); // clear again, but after a 1.5 s gap
    expect(out.map((c) => c.action)).not.toContain('stop');
    expect(am.critical()).toBe('sleep');
  });
});

describe('final review round 3 nit: several Criticals on one frame', () => {
  test.each([
    ['F1, F2, F3 (seed 1101 at a speed-gate lift)', [crit('microsleep'), crit('sleep'), unr({ closure: true })]],
    ['F3 listed first', [unr({ closure: true }), crit('microsleep'), crit('sleep')]],
  ])('%s: only the highest starts; the lower ones are logged as merged', (_name, reqs) => {
    const r = run([{ s: 1, f: asleep, req: reqs }]);
    expect(r.sig).toEqual(['start:unresponsive']);
    const by = r.am.stats().byKind;
    expect(by.microsleep).toMatchObject({ delivered: 0, merged: 1 });
    expect(by.sleep).toMatchObject({ delivered: 0, merged: 1 });
    expect(by.unresponsive.delivered).toBe(1);
  });
  test('a Critical accepted earlier on the frame still corroborates an escalation after it (the order of the requests is kept)', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('microsleep'), unr({ escalation: true })] }]);
    expect(r.sig).toEqual(['start:unresponsive']);
    expect(r.am.stats().invariantViolations).toBe(0);
    expect(r.am.stats().byKind.microsleep.merged).toBe(1);
  });
  test('a Critical refused for speed does not block another (C2: only a D4 request that is not an escalation can be refused)', () => {
    const r = run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 5 }, req: [unr({ origin: 'd4' }), crit('sleep')] }]);
    expect(r.sig).toEqual(['start:sleep']);
    expect(r.am.stats().byKind.unresponsive.suppressed).toBe(1);
  });
  test('F1 and F2 on one frame: sleep only; a later F3 still escalates', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep'), crit('microsleep')] }, { s: 1, f: asleep, req: [unr({ closure: true })] }]);
    expect(r.sig).toEqual(['start:sleep', 'stop:sleep', 'start:unresponsive']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Task C2 (calib-parked design rev4 §2.1.7, §2.1.8; S2): the sleep family at every speed, origins, stops.
// ---------------------------------------------------------------------------------------------------------

describe('C2: the sleep family and stops', () => {
  const stopped: Partial<AlertFrame> = { ...asleep, ruleSpeedKmh: 0, speedKnown: true, stopped: true };
  const sensorStopped: Partial<AlertFrame> = { ...asleep, ruleSpeedKmh: 0, speedKnown: false, stopped: true };
  const d4 = () => unr({ escalation: true, origin: 'd4' });

  test('a sleep-family Critical starts at 0 km/h, stopped, and with no speed at all', () => {
    expect(run([{ s: 1, f: stopped, req: [crit('sleep')] }]).sig).toEqual(['start:sleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [crit('microsleep')] }]).sig).toEqual(['start:microsleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 3 }, req: [crit('microsleep_nod')] }]).sig).toEqual(['start:microsleep_nod']);
  });

  test('S-CRIT-STOP-SLEEP (unit): no stop ends a sleep Critical, GNSS or sensor', () => {
    expect(run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 30, f: stopped }]).sig).toEqual(['start:sleep']);
    expect(run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 30, f: sensorStopped }]).sig).toEqual(['start:sleep']);
  });

  test('while stopped, eyes open for 1 s clears it with the gaze anywhere; while moving the gaze must be on the road', () => {
    const atLight = run([{ s: 1, f: stopped, req: [crit('sleep')] }, { s: 1.2, f: { ...stopped, eyesOpen: true, onRoad: false } }]);
    expect(atLight.sig).toEqual(['start:sleep', 'stop:sleep']);
    const moving = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 3, f: { ...asleep, eyesOpen: true, onRoad: false } }]);
    expect(moving.sig).toEqual(['start:sleep']);
  });

  test('S-D4-STOP (unit): a D4-origin Critical ends after 5 s of STOPPED, GNSS or sensor', () => {
    const warn = { s: 1, f: off, req: [dist('distraction')] };
    for (const f of [stopped, sensorStopped]) {
      expect(run([warn, { s: 1, f: off, req: [d4()] }, { s: 4.9, f }]).sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
      expect(run([warn, { s: 1, f: off, req: [d4()] }, { s: 5.1, f }]).sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive', 'stop:unresponsive']);
    }
  });

  test('S-D4-THEN-SLEEP-STOP (unit, NC-S2): F3 closure merging into a D4 Critical upgrades it to sleep; the stop no longer ends it', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: off, req: [d4()] }, { s: 1, f: asleep, req: [unr({ closure: true, escalation: true, origin: 'sleep' })] }, { s: 20, f: stopped }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
    expect(r.am.stats().byKind.unresponsive.merged).toBe(1);
    expect(r.am.criticalOrigin()).toBe('sleep');
  });

  test('a D4 no-on-road request merging into a D4 Critical keeps the D4 origin: the stop ends it at 5 s', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: off, req: [d4()] }, { s: 1, f: off, req: [unr({ escalation: true, origin: 'd4' })] }, { s: 5.1, f: stopped }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive', 'stop:unresponsive']);
  });

  test('a microsleep request over a D4 Critical replaces it (as today) with a sleep-origin Critical the stop does not end', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: off, req: [d4()] }, { s: 1, f: asleep, req: [crit('microsleep')] }, { s: 20, f: stopped }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive', 'stop:unresponsive', 'start:microsleep']);
  });

  test('a pending D4 (the corroboration) clears after 5 s STOPPED, a sensor stop included', () => {
    // A warning, 5.1 s at a sensor stop, then a D4 escalation: uncorroborated (counted), since the pending cleared.
    const cleared = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 5.1, f: { ...off, ...sensorStopped, eyesOpen: true } }, { s: 1, f: off, req: [d4()] }]);
    expect(cleared.am.violations()).toBe(1);
    const held = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 4.5, f: { ...off, ...sensorStopped, eyesOpen: true } }, { s: 1, f: off, req: [d4()] }]);
    expect(held.am.violations()).toBe(0);
  });

  test('while stopped, a D4-origin Critical is not cleared by open eyes off the road (only its 5 s stop end)', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: off, req: [d4()] }, { s: 3, f: { ...off, ...stopped, eyesOpen: true, onRoad: false } }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
  });

  test('a D4 escalation over a running sleep Critical keeps the sleep origin: the stop does not end it', () => {
    const r = run([{ s: 1, f: off, req: [dist('distraction')] }, { s: 1, f: asleep, req: [crit('sleep')] }, { s: 1, f: { ...asleep, onRoad: false }, req: [d4()] }, { s: 20, f: stopped }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'start:sleep', 'stop:sleep', 'start:unresponsive']);
  });

  test('an F3 closure escalation (origin sleep) at 2 km/h starts: the speed gate reads only D4', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 2 }, req: [unr({ closure: true, origin: 'sleep' })] }]).sig).toEqual(['start:unresponsive']);
  });
});

// C7 round 6 (review-C7 R4-T, the user's decision): eyes_on_road is a Tier 2 alert of the distraction family.
describe('C7 round 6: eyes_on_road', () => {
  const eyes: AlertRequest = { kind: 'eyes_on_road', c8: false };
  test('Tier 2: starts off the road, stops on the first on-road frame (rule 1)', () => {
    const r = run([{ s: 1, f: asleep, req: [eyes] }, { s: 0.2 }]);
    expect(r.sig).toEqual(['start:eyes_on_road', 'stop:eyes_on_road']);
    expect(r.cmds[0]!.tier).toBe(2);
  });
  test('D1 does not double-alert: a D1 while it runs merges, and it merges into a running D1', () => {
    const a = run([{ s: 0.5, f: asleep, req: [eyes] }, { s: 0.5, f: off, req: [dist('distraction')] }]);
    expect(a.sig).toEqual(['start:eyes_on_road']);
    expect(a.am.stats().byKind.distraction.merged).toBe(1);
    const b = run([{ s: 0.5, f: off, req: [dist('distraction')] }, { s: 0.5, f: asleep, req: [eyes] }]);
    expect(b.sig).toEqual(['start:distraction']);
    expect(b.am.stats().byKind.eyes_on_road.merged).toBe(1);
  });
  test('dropped while a Critical runs; a sleep Critical replaces it', () => {
    const a = run([{ s: 0.5, f: asleep, req: [crit('microsleep')] }, { s: 0.5, f: asleep, req: [eyes] }]);
    expect(a.sig).toEqual(['start:microsleep']);
    expect(a.am.stats().byKind.eyes_on_road.dropped).toBe(1);
    const b = run([{ s: 0.5, f: asleep, req: [eyes] }, { s: 0.5, f: asleep, req: [unr({ closure: true, escalation: true })] }]);
    expect(b.sig).toEqual(['start:eyes_on_road', 'stop:eyes_on_road', 'start:unresponsive']);
  });
  test('rule 5 (not from a LOST frame), rule 4 (not below 20 km/h); allowed in the warm-up, as D1', () => {
    expect(run([{ s: 0.5, f: { ...asleep, quality: 'lost' }, req: [eyes] }]).sig).toEqual([]);
    expect(run([{ s: 0.5, f: { ...asleep, ruleSpeedKmh: 15 }, req: [eyes] }]).sig).toEqual([]);
    expect(run([{ s: 0.5, f: { ...asleep, warmup: true }, req: [eyes] }]).sig).toEqual(['start:eyes_on_road']);
  });
  test('it corroborates a following escalation (F3 at 6 s is not an unverified escalation)', () => {
    const r = run([{ s: 0.5, f: asleep, req: [eyes] }, { s: 5, f: asleep }, { s: 0.5, f: asleep, req: [unr({ closure: true, escalation: true })] }]);
    expect(r.am.stats().invariantViolations).toBe(0);
  });
});
