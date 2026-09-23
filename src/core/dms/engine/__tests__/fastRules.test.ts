// Eye closure and the fast rules (plan §M6, C-22, C-25, rev1 I2/I6): closure by the max reliable eye,
// hysteresis, the near eye, the looking-down gate, F1–F4, blinks and the fps meter.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createConditioner, type ConditionerRefs, type Perceived } from '../conditioning';
import { createFpsMeter } from '../eyes';
import { createFastRules, type FastEvent } from '../fastRules';
import { classifyQuality } from '../quality';
import { frame, type FrameSpec } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const REFS: ConditionerRefs = {
  driverSide: 'left',
  gazeSource: 'geometric',
  rollOffsetDeg: 0,
  gazeCentre: { yaw: 0, pitch: 0 },
  headCentre: { yaw: 0, pitch: 0 },
  openEyeEar: { r: 0.3, l: 0.3 },
  pitchReference: 0,
};

/** Frames at `fps`: `open` s of open eyes (iris seen), then segments. Returns perceived frames. */
function perceive(segs: { s: number; spec: Partial<FrameSpec> }[], fps = 15, refs: Partial<ConditionerRefs> = {}): Perceived[] {
  const c = createConditioner(C);
  const out: Perceived[] = [];
  let i = 0;
  for (const seg of [{ s: 1, spec: {} }, ...segs]) {
    const n = Math.round(seg.s * fps);
    for (let k = 0; k < n; k++, i++) {
      const f = frame({ tMs: (i * 1000) / fps, ...seg.spec });
      out.push(c.step(f, classifyQuality(f, C), { ...REFS, ...refs }));
    }
  }
  return out;
}

function fast(ps: Perceived[], speed: number | null = 60, onRoad = (p: Perceived) => !p.eyesClosed && p.source === 'gaze') {
  const r = createFastRules(C);
  const events: FastEvent[] = [];
  for (const p of ps) events.push(...r.onFrame({ p, ruleSpeedKmh: speed, onRoadGaze: onRoad(p) }).events);
  return { events, kinds: events.map((e) => e.kind), rules: r };
}
const ear = (o: number): [number, number] => [0.3 * o, 0.3 * o];

describe('closure measurement (§M6, C-22)', () => {
  test('closed at 0.29, not at 0.31', () => {
    expect(perceive([{ s: 0.2, spec: { ear: ear(0.29) } }]).at(-1)!.eyesClosed).toBe(true);
    expect(perceive([{ s: 0.2, spec: { ear: ear(0.31) } }]).at(-1)!.eyesClosed).toBe(false);
  });
  test('hysteresis: once closed, still closed at 0.44, open at 0.46', () => {
    expect(perceive([{ s: 0.2, spec: { ear: ear(0.1) } }, { s: 0.2, spec: { ear: ear(0.44) } }]).at(-1)!.eyesClosed).toBe(true);
    expect(perceive([{ s: 0.2, spec: { ear: ear(0.1) } }, { s: 0.2, spec: { ear: ear(0.46) } }]).at(-1)!.eyesClosed).toBe(false);
  });
  test('by the max reliable eye (rev1 I2): 0.1/0.45 not closed; 0.29/0.29 closed; one eye glared and the other at 0.2 closed', () => {
    expect(perceive([{ s: 0.2, spec: { ear: [0.03, 0.135] } }]).at(-1)!.eyesClosed).toBe(false);
    expect(perceive([{ s: 0.2, spec: { ear: [0.087, 0.087] } }]).at(-1)!.eyesClosed).toBe(true);
    expect(perceive([{ s: 0.2, spec: { ear: [0.3, 0.06], eyeR: { sat: 0.5 } } }]).at(-1)!.eyesClosed).toBe(true);
  });
  test('the near eye past |yaw| 25°: at 24° the max of both, at 26° the near eye alone', () => {
    const spec = (yaw: number): Partial<FrameSpec> => ({ head: { yaw, pitch: 0, roll: 0 }, gaze: { yaw, pitch: 0 }, ear: [0.03, 0.3], eyeR: { widthPx: 40 }, eyeL: { widthPx: 20 } });
    expect(perceive([{ s: 0.2, spec: spec(24) }]).at(-1)!.eyesClosed).toBe(false);
    expect(perceive([{ s: 0.2, spec: spec(26) }]).at(-1)!.eyesClosed).toBe(true);
  });
});

describe('F1–F3 (§M6)', () => {
  const closedFor = (s: number, o = 0.1, spec: Partial<FrameSpec> = {}) => perceive([{ s, spec: { ear: ear(o), ...spec } }]);
  test('F1 microsleep at 1.0 s (one frame either side at 15 fps) at 25 km/h; never at 19 km/h', () => {
    // n closed frames last (n − 1) intervals: 15 frames = 0.93 s, 16 frames = 1.0 s.
    expect(fast(closedFor(15 / 15), 25).kinds).not.toContain('microsleep');
    expect(fast(closedFor(16 / 15), 25).kinds).toContain('microsleep');
    expect(fast(closedFor(5), 19).kinds).not.toContain('microsleep');
  });
  test('F1 at the 0.1/0.45 split never fires: the max eye is open (the mean would fire)', () => {
    expect(fast(perceive([{ s: 3, spec: { ear: [0.03, 0.135] } }]), 60).kinds).not.toContain('microsleep');
  });
  test('F2 sleep at 3.0 s at 12 km/h; F3 unresponsive at 6.0 s', () => {
    const r = fast(closedFor(6.2), 12);
    expect(r.kinds).toContain('sleep');
    expect(r.kinds).not.toContain('microsleep'); // F1 needs 20 km/h
    const sleep = r.events.find((e) => e.kind === 'sleep')!;
    expect(sleep.tMs - 1000).toBeGreaterThanOrEqual(3000 - 67);
    expect(sleep.tMs - 1000).toBeLessThan(3000 + 67);
    expect(r.kinds.filter((k) => k === 'unresponsive').length).toBeGreaterThanOrEqual(1);
  });
  test('F3: no on-road gaze within 3.0 s of a Critical start → unresponsive; a return clears it', () => {
    // F1 at 1.0 s; the eyes open but stay off-road (not on the road): F3 at 3.0 s after the F1.
    const ps = perceive([{ s: 1.1, spec: { ear: ear(0.1) } }, { s: 4, spec: { gaze: { yaw: 40, pitch: -20 } } }]);
    const off = fast(ps, 60, () => false);
    expect(off.kinds).toContain('unresponsive');
    const back = fast(ps, 60, (p) => !p.eyesClosed);
    expect(back.kinds).not.toContain('unresponsive');
  });
  test('T12: an unknown gaze direction (no zone, e.g. before calibration) neither clears nor counts toward the no-on-road clause', () => {
    // F1 at 1.0 s; then the eyes open with no direction for 10 s (null): nothing; then off road: F3 3.0 s later.
    const ps = perceive([{ s: 1.1, spec: { ear: ear(0.1) } }, { s: 16, spec: { gaze: { yaw: 40, pitch: -20 } } }]);
    const r = createFastRules(C);
    const ev: FastEvent[] = [];
    ps.forEach((p) => ev.push(...r.onFrame({ p, ruleSpeedKmh: 60, onRoadGaze: p.tMs < 12_100 ? null : false }).events));
    const un = ev.filter((e) => e.kind === 'unresponsive');
    expect(un).toHaveLength(1);
    expect(un[0]!.tMs).toBeGreaterThanOrEqual(15_000);
  });
  test('T12: criticalEnded() (the alert manager ended the Critical) ends the no-on-road watch', () => {
    const ps = perceive([{ s: 1.1, spec: { ear: ear(0.1) } }, { s: 6, spec: { gaze: { yaw: 40, pitch: -20 } } }]);
    const r = createFastRules(C);
    const ev: FastEvent[] = [];
    ps.forEach((p, i) => {
      ev.push(...r.onFrame({ p, ruleSpeedKmh: 60, onRoadGaze: false }).events);
      if (i === 40) r.criticalEnded();
    });
    expect(ev.map((e) => e.kind)).toContain('microsleep');
    expect(ev.map((e) => e.kind)).not.toContain('unresponsive');
  });
  test('a HEAD_ONLY frame mid-closure ends the episode silently', () => {
    const r = fast(perceive([{ s: 0.8, spec: { ear: ear(0.1) } }, { s: 0.1, spec: { blur: 5 } }, { s: 0.5, spec: { ear: ear(0.1) } }]), 60);
    expect(r.kinds).not.toContain('microsleep');
    expect(r.kinds).not.toContain('blink');
  });
  test('an active F2 continues through a GNSS loss: no cancellation from the fast rules (rev1 I6)', () => {
    const ps = closedFor(7);
    const r = createFastRules(C);
    const kinds: string[] = [];
    ps.forEach((p, i) => kinds.push(...r.onFrame({ p, ruleSpeedKmh: i < 75 ? 30 : null, onRoadGaze: false }).events.map((e) => e.kind))); // GNSS lost 4 s into the closure
    expect(kinds).toContain('sleep');
    expect(kinds).toContain('unresponsive'); // the escalation of an active Critical, speed unknown
  });
  test('T12: each unresponsive says which clause raised it and whether it escalates a running Critical', () => {
    const ps = closedFor(7);
    const esc = fast(ps, 60).events.find((e) => e.kind === 'unresponsive')!;
    expect(esc).toMatchObject({ clause: 'no_on_road', escalation: true }); // F1 at 1.0 s, no on-road gaze 3 s later
    // F2 and F3 share the ≥ 10 km/h gate and F2's threshold is lower, so the closure clause always follows
    // F2 in its episode: an escalation even when both fire on the frame the speed first reaches 10.
    const late = createFastRules(C);
    const ev: FastEvent[] = [];
    ps.forEach((p) => ev.push(...late.onFrame({ p, ruleSpeedKmh: p.tMs < 7500 ? 5 : 15, onRoadGaze: true }).events));
    expect(ev.filter((e) => e.kind !== 'blink').map((e) => e.kind)).toEqual(['sleep', 'unresponsive']);
    expect(ev.find((e) => e.kind === 'unresponsive')).toMatchObject({ clause: 'closure', escalation: true });
    const esc2 = createFastRules(C);
    const ev2: FastEvent[] = [];
    ps.forEach((p) => ev2.push(...esc2.onFrame({ p, ruleSpeedKmh: 12, onRoadGaze: true }).events)); // on road: only the closure clause
    expect(ev2.filter((e) => e.kind === 'unresponsive')).toEqual([expect.objectContaining({ clause: 'closure', escalation: true })]);
  });
  test('T9 r1 m1: one unresponsive per Critical episode (the no-on-road clause at 3.0 s after F1, not again at 6.0 s)', () => {
    const r = fast(closedFor(7), 60, () => false);
    const un = r.events.filter((e) => e.kind === 'unresponsive');
    expect(un).toHaveLength(1);
    const f1 = r.events.find((e) => e.kind === 'microsleep')!;
    expect(un[0]!.tMs - f1.tMs).toBeGreaterThanOrEqual(3000);
    expect(un[0]!.tMs - f1.tMs).toBeLessThan(3000 + 2 * 67);
  });
});

describe('closure bridging (C-26, T9 review I1)', () => {
  /** 15 fps from spec(t) over [0, seconds) through quality and the conditioner. */
  function run(spec: (t: number) => Partial<FrameSpec>, seconds: number): Perceived[] {
    const c = createConditioner(C);
    const out: Perceived[] = [];
    for (let i = 0; i < Math.round(seconds * 15); i++) {
      const tMs = (i * 1000) / 15;
      const f = frame({ tMs, ...spec(tMs / 1000) });
      out.push(c.step(f, classifyQuality(f, C), REFS));
    }
    return out;
  }
  const head = (pitch: number, yaw = 0): Partial<FrameSpec> => ({ head: { yaw, pitch, roll: 0 }, gaze: { yaw, pitch } });
  const LOST: Partial<FrameSpec> = { face: false };
  /** Open and level to 1 s; the eyes shut at 1 s while the head drops `drop`° over 0.8 s; the face LOST from 1.8 s for `lostS`; then `after`. */
  const nodOff = (drop: number, lostS: number, after: (t: number) => Partial<FrameSpec>, seconds: number) =>
    run((t) => {
      if (t < 1) return {};
      if (t < 1.8) return { ...head((-drop * (t - 1)) / 0.8), ear: ear(0.1) };
      if (t < 1.8 + lostS) return LOST;
      return after(t);
    }, seconds);
  const at = (ps: Perceived[], tS: number) => ps.find((p) => p.tMs >= tS * 1000 - 1e-6)!;
  const within = (e: FastEvent | undefined, fromOnsetMs: number) => {
    expect(e).toBeDefined();
    expect(e!.tMs - 1000).toBeGreaterThanOrEqual(fromOnsetMs - 1e-6);
    expect(e!.tMs - 1000).toBeLessThan(fromOnsetMs + 67);
  };

  test('eyes shut 0.8 s, the head down 10°, the face LOST for 4 s → microsleep at 1.0 s and sleep at 3.0 s, bridged', () => {
    const ps = nodOff(10, 4, () => LOST, 6);
    expect(at(ps, 2).closureBridged).toBe(true);
    expect(at(ps, 2).eyesClosed).toBe(true);
    const r = fast(ps, 60);
    within(r.events.find((e) => e.kind === 'microsleep'), 1000);
    within(r.events.find((e) => e.kind === 'sleep'), 3000);
    expect(r.events.every((e) => e.bridged === true)).toBe(true);
  });
  test('the same with a 20° drop: the looking-down gate carries through the bridge (the deep run: F1 at 1.5 s)', () => {
    const r = fast(nodOff(20, 4, () => LOST, 6), 60);
    within(r.events.find((e) => e.kind === 'microsleep'), 1500);
    within(r.events.find((e) => e.kind === 'sleep'), 3000);
  });
  test('the face returns still closed after 4 s: the same episode, unresponsive once at 6.0 s', () => {
    const ps = nodOff(20, 4, () => ({ ...head(-20), ear: ear(0.1) }), 9);
    const back = at(ps, 6);
    expect(back.quality).toBe('tracking');
    expect(back.eyesClosed).toBe(true);
    expect(back.closureBridged).toBe(false);
    expect(back.closedMs).toBeGreaterThanOrEqual(5000 - 1e-6);
    const r = fast(ps, 60);
    expect(r.kinds.filter((k) => k === 'microsleep')).toHaveLength(1);
    expect(r.kinds.filter((k) => k === 'sleep')).toHaveLength(1);
    expect(r.kinds.filter((k) => k === 'unresponsive')).toHaveLength(1);
    within(r.events.find((e) => e.kind === 'unresponsive'), 6000);
  });
  test('a 12 s loss: the bridge ends silently at the 10 s cap; F3 has already fired', () => {
    const ps = nodOff(10, 12, () => LOST, 15);
    expect(at(ps, 11.7).closureBridged).toBe(true);
    expect(at(ps, 11.9).closureBridged).toBe(false);
    expect(at(ps, 11.9).eyesClosed).toBe(false);
    const r = fast(ps, 60);
    expect(r.kinds.filter((k) => k === 'unresponsive')).toHaveLength(1);
    within(r.events.find((e) => e.kind === 'unresponsive'), 6000);
    expect(r.kinds).not.toContain('blink');
  });
  test('a 200 ms blink during a fast head turn, then LOST → nothing (fails a and c)', () => {
    const ps = run((t) => (t < 1 ? {} : t < 1.2 ? { ...head(-10, (t - 1) * 300), ear: ear(0.1) } : LOST), 4);
    expect(ps.some((p) => p.closureBridged)).toBe(false);
    expect(fast(ps, 60).kinds).toEqual([]);
  });
  test('eyes shut 1 s with the head level, then LOST (a hand rubbing the eyes) → no bridge, no F1/F2 (fails b)', () => {
    const ps = run((t) => (t < 1 ? {} : t < 2 ? { ear: ear(0.1) } : t < 6 ? LOST : {}), 7);
    expect(ps.some((p) => p.closureBridged)).toBe(false);
    const r = fast(ps, 60);
    expect(r.kinds).not.toContain('microsleep');
    expect(r.kinds).not.toContain('sleep');
  });
  test('a bridge, then TRACKING with open eyes → the closure ends with no blink event', () => {
    const ps = nodOff(10, 0.5, () => head(0), 4);
    expect(at(ps, 2.4).eyesClosed).toBe(false);
    const r = fast(ps, 60);
    expect(r.kinds).toContain('microsleep');
    expect(r.kinds).not.toContain('blink');
  });
  test('T9 r1 nit: a TRACKING frame without an openness never starts or keeps a bridge; it ends the closure silently', () => {
    // Past 25° yaw the near eye alone measures closure; a glared near eye leaves TRACKING (the far eye
    // usable) with no openness. The yaw is held throughout, so no turn evidence is involved.
    const turned = (pitch: number, nearGlare: boolean): Partial<FrameSpec> => ({
      ...head(pitch, 30),
      ear: ear(0.1),
      eyeR: { widthPx: 40, ...(nearGlare ? { sat: 0.5 } : {}) },
      eyeL: { widthPx: 20 },
    });
    const start = run((t) => (t < 1 ? head(-10, 30) : t < 1.8 ? turned(-10, false) : turned(-10, true)), 3);
    expect(at(start, 1.7).eyesClosed).toBe(true);
    expect(at(start, 2).quality).toBe('tracking');
    expect(at(start, 2).openness).toBeNull();
    expect(start.some((p) => p.closureBridged)).toBe(false);
    expect(at(start, 2).eyesClosed).toBe(false);
    // Keep: a bridge started by a LOST frame ends on the first TRACKING frame without an openness.
    const keep = run((t) => (t < 1 ? head(-10, 30) : t < 1.8 ? turned(-10, false) : t < 2.2 ? LOST : turned(-10, true)), 3);
    expect(at(keep, 2).closureBridged).toBe(true);
    expect(keep.filter((p) => p.quality === 'tracking').some((p) => p.closureBridged)).toBe(false);
    expect(at(keep, 2.5).eyesClosed).toBe(false);
  });
  test('the eye tier holds through a bridge: the face back closed 11 s after the last iris is still TRACKING', () => {
    const ps = run((t) => (t < 1 ? {} : t < 3 ? { ...head(-10), ear: ear(0.1) } : t < 12 ? LOST : { ...head(-10), ear: ear(0.1) }), 13);
    expect(at(ps, 11.9).closureBridged).toBe(true);
    const back = at(ps, 12.2);
    expect(back.quality).toBe('tracking');
    expect(back.eyesClosed).toBe(true);
    expect(back.closedMs).toBeGreaterThanOrEqual(11_000);
  });
});

describe('frame gaps (T12 review I1): unobserved time never counts', () => {
  /** Frames at 15 fps with a gap: `before` s of spec A, nothing for `gapS`, then `after` s of spec B. */
  function withGap(a: Partial<FrameSpec>, beforeS: number, gapS: number, b: Partial<FrameSpec>, afterS: number): Perceived[] {
    const c = createConditioner(C);
    const out: Perceived[] = [];
    const push = (tMs: number, spec: Partial<FrameSpec>) => {
      const f = frame({ tMs, ...spec });
      out.push(c.step(f, classifyQuality(f, C), REFS));
    };
    let t = 0;
    for (; t < 1000; t += 1000 / 15) push(t, {});
    for (; t < 1000 + beforeS * 1000; t += 1000 / 15) push(t, a);
    t += gapS * 1000;
    for (const end = t + afterS * 1000; t < end; t += 1000 / 15) push(t, b);
    return out;
  }
  test('a frame after more than maxFrameGapS is a gap; the closure before it ends silently, a new one starts', () => {
    const ps = withGap({ ear: ear(0.1) }, 0.4, 2, { ear: ear(0.1) }, 1.5);
    const g = ps.find((p) => p.gap)!;
    expect(g).toBeDefined();
    expect(ps.filter((p) => p.gap)).toHaveLength(1);
    expect(g.eyesClosed).toBe(true);
    expect(g.closedMs).toBe(0); // a new closure starts at the gap frame
    const r = fast(ps, 60);
    const f1 = r.events.find((e) => e.kind === 'microsleep')!;
    expect(f1.tMs - g.tMs).toBeGreaterThanOrEqual(1000 - 1e-6); // 1.0 s of OBSERVED closure after the gap
    expect(r.kinds).not.toContain('blink');
  });
  test('an active C-26 bridge continues through a gap (its cap still applies)', () => {
    const c = createConditioner(C);
    const down = (p: number): Partial<FrameSpec> => ({ head: { yaw: 0, pitch: p, roll: 0 }, gaze: { yaw: 0, pitch: p }, ear: ear(0.1) });
    const ps: Perceived[] = [];
    const push = (tMs: number, spec: Partial<FrameSpec>) => {
      const f = frame({ tMs, ...spec });
      ps.push(c.step(f, classifyQuality(f, C), REFS));
    };
    let t = 0;
    for (; t < 1000; t += 1000 / 15) push(t, {});
    for (; t < 1800; t += 1000 / 15) push(t, down(-10));
    for (; t < 2500; t += 1000 / 15) push(t, { face: false });
    push(t + 2000, { face: false }); // a 2 s gap inside the bridge
    expect(ps.at(-1)!.gap).toBe(true);
    expect(ps.at(-1)!.closureBridged).toBe(true);
    expect(ps.at(-1)!.eyesClosed).toBe(true);
  });
  test('a 0.4 s interval (two frames at 5 fps) is not a gap', () => {
    const c = createConditioner(C);
    const a = c.step(frame({ tMs: 0 }), classifyQuality(frame({ tMs: 0 }), C), REFS);
    const b = c.step(frame({ tMs: 400 }), classifyQuality(frame({ tMs: 400 }), C), REFS);
    expect([a.gap, b.gap]).toEqual([false, false]);
  });
});

describe('the looking-down gate (§M6)', () => {
  const down: Partial<FrameSpec> = { head: { yaw: 0, pitch: -25, roll: 0 }, gaze: { yaw: 0, pitch: -25 } };
  test('openness 0.2 with the head down never counts (a speedometer check)', () => {
    expect(fast(perceive([{ s: 3, spec: { ...down, ear: ear(0.2) } }]), 60).kinds).not.toContain('microsleep');
  });
  test('openness 0.14 with the head down counts only at 1.5 s', () => {
    expect(fast(perceive([{ s: 1.4, spec: { ...down, ear: ear(0.14) } }]), 60).kinds).not.toContain('microsleep');
    expect(fast(perceive([{ s: 1.6, spec: { ...down, ear: ear(0.14) } }]), 60).kinds).toContain('microsleep');
  });
});

describe('F4 (C-25)', () => {
  test('one F1 holds the level at Drowsy for 15 min; two within 10 min force Severe for 15 min', () => {
    const r = createFastRules(C);
    const at = (tMs: number, closed: boolean) => r.onFrame({ p: { ...perceive([])[0]!, tMs, eyesClosed: closed, closedMs: closed ? 1100 : 0, quality: 'tracking', lookingDown: false, openness: closed ? 0.1 : 1 }, ruleSpeedKmh: 60, onRoadGaze: !closed });
    at(0, true);
    at(100, false);
    expect(r.fatigueFloor(1000)).toBe('drowsy');
    expect(r.fatigueFloor(900_001)).toBe('none');
    at(500_000, true);
    expect(r.fatigueFloor(500_000)).toBe('severe');
    expect(r.fatigueFloor(500_000 + 900_000)).toBe('severe');
    expect(r.fatigueFloor(500_000 + 900_001)).toBe('none');
  });
  test('two F1 more than 10 min apart are not Severe', () => {
    const r = createFastRules(C);
    const at = (tMs: number, closed: boolean) => r.onFrame({ p: { ...perceive([])[0]!, tMs, eyesClosed: closed, closedMs: closed ? 1100 : 0, quality: 'tracking', lookingDown: false, openness: closed ? 0.1 : 1 }, ruleSpeedKmh: 60, onRoadGaze: !closed });
    at(0, true);
    at(100, false);
    at(600_001, true);
    expect(r.fatigueFloor(600_001)).toBe('drowsy');
  });
});

describe('blinks and the fps meter', () => {
  test('a finished closure is a blink; ≥ 500 ms is long; counted only at ≥ 12.5 fps measured', () => {
    const blinks = (fps: number, s: number) =>
      fast(perceive([{ s, spec: { ear: ear(0.1) } }, { s: 0.5, spec: {} }], fps), 60).events.filter((e) => e.kind === 'blink');
    const b15 = blinks(15, 0.2);
    expect(b15).toHaveLength(1);
    expect(b15[0]).toMatchObject({ long: false, counted: true });
    expect(blinks(15, 0.6)[0]).toMatchObject({ long: true, counted: true });
    expect(blinks(10, 0.3)[0]).toMatchObject({ counted: false }); // blinks under 15 fps give no statistics
  });
  test('T12: the incremental median equals the plain median of the window on a jittery, gappy stream', () => {
    const m = createFpsMeter(C);
    let t = 0;
    const kept: { t: number; dt: number }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 3000; i++) {
      const dt = rnd() < 0.02 ? 400 + Math.round(rnd() * 900) : [33, 34, 66, 67, 100, 125][Math.floor(rnd() * 6)]!;
      const prev = t;
      t += dt;
      m.push(t);
      if (i > 0 || prev > 0) kept.push({ t, dt });
      while (kept.length > 0 && kept[0]!.t <= t - 10_000) kept.shift();
      while (kept.length > 302) kept.shift();
      if (kept.length === 0) {
        expect(m.fps()).toBe(0);
        continue;
      }
      const s = kept.map((x) => x.dt).sort((a, b) => a - b);
      const med = s.length % 2 === 1 ? s[s.length >> 1]! : (s[(s.length >> 1) - 1]! + s[s.length >> 1]!) / 2;
      expect(m.fps()).toBeCloseTo(1000 / med, 9);
    }
  });
  test('the measured fps is 1000 / the median dt over the last 10 s', () => {
    const m = createFpsMeter(C);
    for (let i = 0; i < 150; i++) m.push((i * 1000) / 15);
    expect(m.fps()).toBeCloseTo(15, 6);
    for (let i = 150; i < 300; i++) m.push(10_000 + ((i - 150) * 1000) / 8);
    expect(m.fps()).toBeCloseTo(8, 6); // the old 15 fps frames have left the window
  });
});
