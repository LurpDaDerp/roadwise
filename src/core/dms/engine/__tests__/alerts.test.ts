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
/** `unresponsive`: closure (F3), no-on-road (F3's second clause) or D4; every flag required. */
const unr = (o: Partial<{ closure: boolean; bridged: boolean; c8: boolean; escalation: boolean }> = {}): AlertRequest => ({
  kind: 'unresponsive',
  closure: o.closure ?? false,
  bridged: o.bridged ?? false,
  c8: o.c8 ?? false,
  escalation: o.escalation ?? false,
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

describe('the Critical speed rules (rule 4, rev1 I6, T8 review m4)', () => {
  test('a Critical may start at ≥ 10 km/h, not at 9 or with no speed', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 10 }, req: [crit('sleep')] }]).sig).toEqual(['start:sleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 9 }, req: [crit('sleep')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [crit('sleep')] }]).sig).toEqual([]);
  });
  test('it continues through a slowdown and ends only after a KNOWN speed < 10 km/h for 5 s', () => {
    const slow = (s: number) => run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(slow(4.9).sig).toEqual(['start:sleep']);
    expect(slow(5.1).sig).toEqual(['start:sleep', 'stop:sleep']);
  });
  test('an unknown (or held, inferred) speed never ends it', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 60, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false } }, { s: 30, f: { ...asleep, ruleSpeedKmh: 0, speedKnown: false } }]);
    expect(r.sig).toEqual(['start:sleep']);
  });
  test('a known ≥ 10 km/h frame restarts the 5 s', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }, { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }, { s: 0.1, f: { ...asleep, ruleSpeedKmh: 12 } }, { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(r.sig).toEqual(['start:sleep']);
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
  test('a fresh microsleep at 8 km/h is still suppressed', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 8 }, req: [crit('microsleep')] }]).sig).toEqual([]);
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
  test('frames at 1 Hz with quality lost and a known 5 km/h end a Critical after 5 s', () => {
    const am = createAlertManager(C, { mode: 'live' });
    run([{ s: 1, f: asleep, req: [crit('sleep')] }], 'live', am);
    const out: string[] = [];
    for (let k = 1; k <= 7; k++) {
      const tMs = 1000 + k * 1000;
      out.push(...am.onFrame({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: 5, speedKnown: true, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [] }).map((c) => `${c.action}:${c.kind}@${c.tMs}`));
    }
    expect(out).toEqual(['stop:sleep@7000']);
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
  const blind = (tMs: number, speed: number | null = 60, speedKnown = true): AlertFrame => ({ tMs, epochMs: EPOCH0 + tMs, ruleSpeedKmh: speed, speedKnown, quality: 'lost', onRoad: false, eyesOpen: false, warmup: false, requests: [], blind: true });
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
  test('a known 5 km/h for 5 s still ends it (no monitoring_paused)', () => {
    const r = run([{ s: 1, f: asleep, req: [crit('sleep')] }]);
    r.am.cameraOff(1000, EPOCH0 + 1000, 'dark');
    const out: DmsAlertCommand[] = [];
    for (let k = 1; k <= 7; k++) out.push(...r.am.onFrame(blind(1000 + k * 1000, 5)));
    expect(out.map((c) => `${c.action}:${c.kind}`)).toEqual(['stop:sleep']);
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
