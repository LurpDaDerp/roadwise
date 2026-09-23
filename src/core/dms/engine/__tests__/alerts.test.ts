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
const R = (kind: AlertRequest['kind'], extra: Partial<AlertRequest> = {}): AlertRequest => ({ kind, ...extra });

describe('the state diagram (§M8)', () => {
  test('Tier 2 distraction: start off road, stop on the first on-road frame (rule 1); no stop while still off road', () => {
    const r = run([{ s: 1, f: off, req: [R('distraction')] }, { s: 0.2 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.cmds[0]).toMatchObject({ tier: 2, id: 1, muted: false, epochMs: EPOCH0 });
    expect(r.cmds[1]!.tMs).toBeCloseTo(1000, 6); // the first on-road frame
    expect(run([{ s: 3, f: off, req: [R('distraction')] }]).sig).toEqual(['start:distraction']);
  });
  test('Critical: continuous through LOST at speed; ends once the eyes are open AND on road for 1.0 s (not 0.9 s)', () => {
    const r = run([{ s: 1, f: asleep, req: [R('microsleep', { closure: true })] }, { s: 3, f: { ...asleep, quality: 'lost' } }, { s: 0.9 }, { s: 0.5, f: off }]);
    expect(r.sig).toEqual(['start:microsleep']);
    expect(r.cmds[0]!.tier).toBe(3);
    const done = run([{ s: 1, f: asleep, req: [R('microsleep', { closure: true })] }, { s: 3, f: { ...asleep, quality: 'lost' } }, { s: 1.2 }]);
    expect(done.sig).toEqual(['start:microsleep', 'stop:microsleep']);
    expect(done.cmds[1]!.tMs - 4000).toBeGreaterThanOrEqual(1000 - 1e-6);
    expect(done.cmds[1]!.tMs - 4000).toBeLessThan(1000 + 67);
    // Open eyes looking away do not end it.
    expect(run([{ s: 1, f: asleep, req: [R('sleep', { closure: true })] }, { s: 3, f: off }]).sig).toEqual(['start:sleep']);
  });
  test('a Critical replaces a running Tier 2 distraction; a new Critical kind replaces the running one', () => {
    expect(run([{ s: 0.5, f: off, req: [R('distraction')] }, { s: 0.5, f: asleep, req: [R('unresponsive')] }]).sig).toEqual(['start:distraction', 'stop:distraction', 'start:unresponsive']);
    expect(run([{ s: 1, f: asleep, req: [R('microsleep', { closure: true })] }, { s: 2, f: asleep, req: [R('sleep', { closure: true })] }]).sig).toEqual(['start:microsleep', 'stop:microsleep', 'start:sleep']);
  });
});

describe('the Critical speed rules (rule 4, rev1 I6, T8 review m4)', () => {
  test('a Critical may start at ≥ 10 km/h, not at 9 or with no speed', () => {
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 10 }, req: [R('sleep', { closure: true })] }]).sig).toEqual(['start:sleep']);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: 9 }, req: [R('sleep', { closure: true })] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false }, req: [R('sleep', { closure: true })] }]).sig).toEqual([]);
  });
  test('it continues through a slowdown and ends only after a KNOWN speed < 10 km/h for 5 s', () => {
    const slow = (s: number) => run([{ s: 1, f: asleep, req: [R('sleep', { closure: true })] }, { s, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(slow(4.9).sig).toEqual(['start:sleep']);
    expect(slow(5.1).sig).toEqual(['start:sleep', 'stop:sleep']);
  });
  test('an unknown (or held, inferred) speed never ends it', () => {
    const r = run([{ s: 1, f: asleep, req: [R('sleep', { closure: true })] }, { s: 60, f: { ...asleep, ruleSpeedKmh: null, speedKnown: false } }, { s: 30, f: { ...asleep, ruleSpeedKmh: 0, speedKnown: false } }]);
    expect(r.sig).toEqual(['start:sleep']);
  });
  test('a known ≥ 10 km/h frame restarts the 5 s', () => {
    const r = run([{ s: 1, f: asleep, req: [R('sleep', { closure: true })] }, { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }, { s: 0.1, f: { ...asleep, ruleSpeedKmh: 12 } }, { s: 4, f: { ...asleep, ruleSpeedKmh: 5 } }]);
    expect(r.sig).toEqual(['start:sleep']);
  });
});

describe('priority and the 10 s defer/drop', () => {
  test('a fatigue burst held by a Tier 2 distraction plays once the distraction stops within 10 s', () => {
    const r = run([{ s: 0.5, f: off, req: [R('distraction')] }, { s: 3, f: off, req: [R('fatigue')] }, { s: 0.2 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'once:fatigue']);
    expect(r.cmds[2]!.tier).toBe(2);
  });
  test('held past 10 s it is dropped (logged)', () => {
    const r = run([{ s: 0.5, f: off, req: [R('distraction')] }, { s: 10.5, f: off, req: [R('fatigue')] }, { s: 1 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.am.stats().byKind.fatigue).toMatchObject({ dropped: 1, delivered: 0 });
  });
  test('Tier 1 waits behind a Critical and is dropped after 10 s; a distraction during a Critical is dropped at once', () => {
    const r = run([{ s: 1, f: asleep, req: [R('sleep', { closure: true })] }, { s: 12, f: asleep, req: [R('phone_pattern'), R('distraction')] }, { s: 2 }]);
    expect(r.sig).toEqual(['start:sleep', 'stop:sleep']);
    expect(r.am.stats().byKind.phone_pattern!.dropped).toBe(1);
    expect(r.am.stats().byKind.distraction!.dropped).toBe(1);
  });
  test('the fatigue burst goes before a held Tier 1', () => {
    const r = run([{ s: 0.5, f: off, req: [R('distraction')] }, { s: 2, f: off, req: [R('phone_pattern'), R('fatigue')] }, { s: 0.5 }]);
    expect(r.sig).toEqual(['start:distraction', 'stop:distraction', 'once:fatigue', 'once:phone_pattern']);
  });
});

describe('anti-annoyance rules (§M8)', () => {
  test('rule 3: Tier 1 at most once per 10 min per type; another type is not blocked', () => {
    const r = run([{ s: 1, req: [R('phone_pattern')] }, { s: 598, req: [R('phone_pattern')] }, { s: 1, req: [R('fatigue_early')] }, { s: 2, req: [R('phone_pattern')] }]);
    expect(r.sig).toEqual(['once:phone_pattern', 'once:fatigue_early', 'once:phone_pattern']);
    expect(r.cmds.every((c) => c.tier === 1)).toBe(true);
    expect(r.am.stats().byKind.phone_pattern).toMatchObject({ delivered: 2, suppressed: 1 });
  });
  test('rule 4: nothing audible below 20 km/h (Tier 1 and 2); a running distraction stops when the speed falls below it', () => {
    expect(run([{ s: 1, f: { ...off, ruleSpeedKmh: 15 }, req: [R('distraction'), R('fatigue'), R('phone_pattern')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...off, ruleSpeedKmh: 20 }, req: [R('distraction')] }]).sig).toEqual(['start:distraction']);
    expect(run([{ s: 1, f: off, req: [R('distraction')] }, { s: 1, f: { ...off, ruleSpeedKmh: 15 } }]).sig).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('rule 5: no distraction alert from a LOST frame except C-8; no closure Critical from HEAD_ONLY or LOST unless bridged (C-26)', () => {
    expect(run([{ s: 1, f: { ...off, quality: 'lost' }, req: [R('distraction')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...off, quality: 'lost' }, req: [R('distraction', { c8: true })] }]).sig).toEqual(['start:distraction']);
    expect(run([{ s: 1, f: { ...asleep, quality: 'head_only' }, req: [R('microsleep', { closure: true })] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: { ...asleep, quality: 'lost' }, req: [R('microsleep', { closure: true, bridged: true })] }]).sig).toEqual(['start:microsleep']);
  });
  test('rule 6: warm-up allows only Critical and D1', () => {
    const w: Partial<AlertFrame> = { ...off, warmup: true };
    expect(run([{ s: 1, f: w, req: [R('cumulative'), R('phone_pattern'), R('fatigue'), R('fatigue_early')] }]).sig).toEqual([]);
    expect(run([{ s: 1, f: w, req: [R('distraction')] }]).sig).toEqual(['start:distraction']);
    expect(run([{ s: 1, f: { ...w, eyesOpen: false }, req: [R('microsleep', { closure: true })] }]).sig).toEqual(['start:microsleep']);
    expect(run([{ s: 1, f: off, req: [R('cumulative')] }]).sig).toEqual(['start:cumulative']);
  });
  test('rule 7: tagLastAlert("wrong") tags the last alert and changes nothing live', () => {
    const segs: Seg[] = [{ s: 1, f: off, req: [R('distraction')] }, { s: 1 }, { s: 1, f: off, req: [R('distraction')] }, { s: 1 }];
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
  test('rule 8: three Tier 2 distraction warnings within 10 min → one Tier 1 repeated_glances plus an event flag, no louder tier', () => {
    const warn = (gapS: number): Seg[] => [{ s: 1, f: off, req: [R('distraction')] }, { s: gapS }];
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
    expect(run([{ s: 0.5, f: off, req: [R('distraction')] }, { s: 0.5, f: off, req: [R('distraction')] }]).sig).toEqual(['start:distraction']);
  });
});

describe('shadow mode', () => {
  test('everything is decided the same, and every command is muted', () => {
    const segs: Seg[] = [{ s: 0.5, f: off, req: [R('distraction')] }, { s: 0.5, f: asleep, req: [R('unresponsive')] }, { s: 2 }, { s: 1, req: [R('phone_pattern')] }];
    const live = run(segs);
    const shadow = run(segs, 'shadow');
    expect(shadow.sig).toEqual(live.sig);
    expect(shadow.cmds.every((c) => c.muted)).toBe(true);
    expect(live.cmds.every((c) => !c.muted)).toBe(true);
    expect(shadow.am.stats().byKind.phone_pattern).toMatchObject({ muted: 1, delivered: 0 });
  });
});
