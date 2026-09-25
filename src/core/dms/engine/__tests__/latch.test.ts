// Task C7 (review-C2 §3, the T7 ruling; review-C6 Round 2, the T7 pre-ruling; rev2 §2.3.6; rev5 §2): the
// looking-down latch against the FROZEN gate references, R-a (the raw gaze: two frames within 300 ms, or one frame
// far beyond noise with every usable eye reliable and the eyes agreeing) and R-b (STOPPED only: a head dip to −6°
// in the first 1.0 s). Unit level: the conditioner and the fast rules on synthetic frames.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createConditioner, type ConditionerRefs, type Perceived } from '../conditioning';
import { createFastRules, type FastEvent } from '../fastRules';
import { classifyQuality } from '../quality';
import { frame, gauss, rng, type FrameSpec } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const RAD = Math.PI / 180;
const FPS = 15;
const FRAME_MS = 1000 / FPS;
const ZERO = { yaw: 0, pitch: 0 };
/** Centres and gate references at 0 (the driver frame's pitch is the camera's; rel = absolute). */
const REFS: ConditionerRefs = {
  driverSide: 'left',
  gazeSource: 'geometric',
  rollOffsetDeg: 0,
  gazeCentre: ZERO,
  headCentre: ZERO,
  openEyeEar: { r: 0.3, l: 0.3 },
  pitchReference: 0,
  gateGazeRef: ZERO,
  gateGeoRef: ZERO,
  gateHeadRef: ZERO,
  rawSigmaDeg: 4,
};

/** The iris offset that encodes an eye's own gaze pitch (the fixture's inverse), for per-eye noise and spikes. */
const oyFor = (gazePitch: number, headPitch: number) => C.geometric.kEye * Math.sin(((gazePitch - headPitch) / C.geometric.gPitch) * RAD);

interface Frm {
  /** combined gaze pitch; per-eye pitches override it */
  gaze?: number;
  pitchR?: number;
  pitchL?: number;
  head?: number;
  ear?: number;
  /** the left eye usable but unreliable (the iris not found) */
  leftUnreliable?: boolean;
  /** the iris seen whatever the EAR (a half-closed lid that still shows it) */
  irisSeen?: boolean;
}

function perceive(frames: Frm[], refs: Partial<ConditionerRefs> = {}): Perceived[] {
  const c = createConditioner(C);
  return frames.map((x, i) => {
    const head = x.head ?? 0;
    const gaze = x.gaze ?? 0;
    const ear = x.ear ?? 0.3;
    const spec: FrameSpec = { tMs: i * FRAME_MS, head: { yaw: 0, pitch: head, roll: 0 }, gaze: { yaw: 0, pitch: gaze }, ear: [ear, ear] };
    const open = ear > 0.1 || x.irisSeen === true;
    if (open && x.pitchR !== undefined) spec.eyeR = { oy: oyFor(x.pitchR, head) };
    if (open && x.pitchL !== undefined) spec.eyeL = { oy: oyFor(x.pitchL, head) };
    if (open && x.leftUnreliable === true) spec.eyeL = { ...(spec.eyeL ?? {}), irisContrast: 2, irisIn: false };
    if (x.irisSeen === true) {
      spec.eyeR = { ...(spec.eyeR ?? {}), irisContrast: 40, irisIn: true };
      spec.eyeL = { ...(spec.eyeL ?? {}), irisContrast: 40, irisIn: true };
    }
    const f = frame(spec);
    return c.step(f, classifyQuality(f, C), { ...REFS, ...refs });
  });
}

function rules(ps: Perceived[], o: { stopped?: boolean; speed?: number; cfg?: DmsConfig } = {}): FastEvent[] {
  const r = createFastRules(o.cfg ?? C);
  const ev: FastEvent[] = [];
  for (const p of ps) ev.push(...r.onFrame({ p, ruleSpeedKmh: o.speed ?? 60, onRoadGaze: !p.eyesClosed, stopped: o.stopped ?? false, fps: FPS }).events);
  return ev;
}

/** ms from the closure's onset to F1 (null: no F1) */
function f1Latency(ps: Perceived[], ev: FastEvent[]): number | null {
  const f1 = ev.find((e) => e.kind === 'microsleep');
  const onset = ps.find((p) => p.eyesClosed);
  return f1 === undefined || onset === undefined ? null : f1.tMs - onset.tMs;
}
const n = (s: number) => Math.round(s * FPS);
const repeat = (k: number, f: (i: number) => Frm): Frm[] => Array.from({ length: k }, (_, i) => f(i));
const ONE_S = 1000 + FRAME_MS + 1;
const ONE_HALF_S = 1500 + FRAME_MS + 1;

describe('R-b at a stop: nod-offs at a light (review-C2 §3)', () => {
  // C7 round 2 (the coordinator's stop ruling, review-C7 Round 1 §3 (b)): at a stop every closure counts deep-only, as
  // if latched: the level-head nod-off at a light pays the +0.5 s (the pin moves from 1.0 s to 1.5 s).
  test('S-NODOFF-LIGHT-LEVEL: stopped, head level, lids to 0.05: F1 in (1.0 s, 1.5 s] + 1 frame (the stop ruling)', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2), () => ({ ear: 0.015 }))]);
    const lat = f1Latency(ps, rules(ps, { stopped: true, speed: 0 }))!;
    expect(lat).toBeGreaterThan(ONE_S);
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
  });
  test('S-NODOFF-LIGHT-DIP: stopped, the head dips to −7° within 0.5 s, lids to 0.05: F1 ≤ 1.5 s + 1 frame (R-b latches: the +0.5 s cost)', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2.5), (i) => { const h = -7 * Math.min(1, i / n(0.5)); return { ear: 0.015, head: h, gaze: h }; })]);
    const lat = f1Latency(ps, rules(ps, { stopped: true, speed: 0 }))!;
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
    expect(lat).toBeGreaterThan(ONE_S);
  });
  // R-b is defence in depth since the stop ruling (every stop closure counts deep-only); its latch is read directly.
  test('R-b is relative (C7-2): a head already at −8° before onset that stays there is no dip; a further 3° dip latches', () => {
    const latchAt = (ps: ReturnType<typeof perceive>) => {
      const r = createFastRules(C);
      let set = false;
      for (const p of ps) {
        r.onFrame({ p, ruleSpeedKmh: 0, onRoadGaze: !p.eyesClosed, stopped: true, fps: FPS });
        set ||= r.episodeGated();
      }
      return set;
    };
    const steady = perceive([...repeat(n(1.5), () => ({ head: -8, gaze: -8 })), ...repeat(n(2.5), () => ({ ear: 0.015, head: -8, gaze: -8 }))]);
    expect(latchAt(steady)).toBe(false);
    const dip = perceive([...repeat(n(1.5), () => ({ head: -8, gaze: -8 })), ...repeat(n(2.5), (i) => { const h = -8 - 3.5 * Math.min(1, i / n(0.5)); return { ear: 0.015, head: h, gaze: h }; })]);
    expect(latchAt(dip)).toBe(true);
  });
  test('while moving R-b is off (NC-T7c): the same dip gives F1 at 1.0 s + 1 frame', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2.5), (i) => { const h = -7 * Math.min(1, i / n(0.5)); return { ear: 0.015, head: h, gaze: h }; })]);
    expect(f1Latency(ps, rules(ps))!).toBeLessThanOrEqual(ONE_S);
  });
});

describe('R-a: the raw gaze, the noise guard and the single-frame path (the T7 pre-ruling)', () => {
  // C7 round 1 (review-C7 C7-1): the gaze-set latch stays with the head level (it clears only on a raw frame back up
  // or the head rising), so a nod-off whose eyes roll down first pays the accepted +0.5 s.
  test('S-NODOFF-GAZE-DROP: the gaze falls to −30° within 0.3 s (head level), then the lids close to 0.05: F1 in (1.0 s, 1.5 s] + 1 frame', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(0.3), (i) => ({ gaze: (-30 * (i + 1)) / n(0.3) })), ...repeat(n(0.2), () => ({ gaze: -30 })), ...repeat(n(2), () => ({ gaze: -30, ear: 0.015 }))]);
    const lat = f1Latency(ps, rules(ps))!;
    expect(lat).toBeGreaterThan(ONE_S);
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
  });
  // C7 round 3 (review-C7 R2-S): S-GATED-NOISY-LID, S-NODOFF-GAZE-DROP with a noisy closed lid (0.10 and 0.12 ± 0.03
  // and ± 0.04 per frame): the latched count is the bridged deep run, so F1 comes at 1.5 s, not seconds later.
  test.each([
    [0.1, 0.03],
    [0.1, 0.04],
    [0.12, 0.03],
    [0.12, 0.04],
  ])('S-GATED-NOISY-LID: the gaze drops to −30°, then the lids close at %f ± %f: F1 in (1.0 s, 1.8 s]', (base, sd) => {
    const r = rng(23);
    const ps = perceive([
      ...repeat(n(1), () => ({})),
      ...repeat(n(0.3), (i) => ({ gaze: (-30 * (i + 1)) / n(0.3) })),
      ...repeat(n(0.2), () => ({ gaze: -30 })),
      ...repeat(n(4), () => ({ gaze: -30, ear: 0.3 * Math.max(0.01, base + sd * gauss(r)) })),
    ]);
    const lat = f1Latency(ps, rules(ps))!;
    expect(lat).toBeGreaterThan(ONE_S);
    expect(lat).toBeLessThanOrEqual(1800);
  });
  test('the gaze latch clears on a reliable raw frame back above −12° (the iris seen and up): a closure at 0.2 openness then counts', () => {
    // Read at −40° (head level), then a half-closed lid (openness 0.25, the iris still seen) whose gaze is back up at
    // −5°: the latch clears and the closure counts.
    const ps = perceive([
      ...repeat(n(1), () => ({})),
      { gaze: -40, pitchR: -40, pitchL: -40 },
      ...repeat(n(0.6), () => ({ gaze: -40, ear: 0.015 })),
      ...repeat(n(2), () => ({ gaze: -5, pitchR: -5, pitchL: -5, ear: 0.075, irisSeen: true })),
    ]);
    expect(rules(ps).some((e) => e.kind === 'microsleep')).toBe(true);
  });
  test('the gaze latch clears on the head rising 3° above its onset pitch for 300 ms', () => {
    const ps = perceive([...repeat(n(1), () => ({})), { gaze: -40, pitchR: -40, pitchL: -40, head: -8 }, ...repeat(n(0.6), () => ({ gaze: -40, ear: 0.015, head: -8 })), ...repeat(n(2), () => ({ gaze: -40, ear: 0.075, head: -4 }))]);
    expect(rules(ps).some((e) => e.kind === 'microsleep')).toBe(true);
    // the head staying at −8°: latched, the 0.25 lid never counts
    const held = perceive([...repeat(n(1), () => ({})), { gaze: -40, pitchR: -40, pitchL: -40, head: -8 }, ...repeat(n(2.6), () => ({ gaze: -40, ear: 0.075, head: -8 }))]);
    expect(rules(held).some((e) => e.kind === 'microsleep')).toBe(false);
  });

  /**
   * 100 forward microsleeps (1.2 s open forward, then shut while the head sinks to −8° within 0.2 s: a nod-off), the
   * raw pitch noise from `noise`; the F1 latencies. The sinking head keeps a false latch from clearing (a level head
   * clears it within 300 ms and F1 is not delayed), so a false latch shows as F1 at 1.5 s.
   */
  function forward(noise: (r: () => number) => { r: number; l: number }, o: { glitchEvery?: number; glitch?: 'agree' | 'disagree' | 'unreliable'; sigma?: number; cfg?: DmsConfig } = {}) {
    const r = rng(17);
    const out: { latency: number | null; glitched: boolean }[] = [];
    for (let k = 0; k < 100; k++) {
      const glitched = o.glitchEvery !== undefined && k % o.glitchEvery === 0;
      const open = repeat(n(1.2), () => {
        const e = noise(r);
        return { pitchR: e.r, pitchL: e.l, gaze: (e.r + e.l) / 2 };
      });
      if (glitched) {
        const last = open[open.length - 1]!;
        if (o.glitch === 'unreliable') open[open.length - 1] = { ...last, pitchR: -30, leftUnreliable: true, gaze: -30 };
        else open[open.length - 1] = { ...last, pitchR: -60, pitchL: 0, gaze: -30 };
      }
      const ps = perceive([...open, ...repeat(n(1.5), (i) => ({ ear: 0.015, head: -8 * Math.min(1, (i + 1) / 3), gaze: -8 * Math.min(1, (i + 1) / 3) }))], { rawSigmaDeg: o.sigma ?? 4 });
      out.push({ latency: f1Latency(ps, rules(ps, { cfg: o.cfg })), glitched });
    }
    return out;
  }
  const onTime = (xs: { latency: number | null }[]) => xs.filter((x) => x.latency !== null && x.latency <= ONE_S).length;

  test('S-FWD-LATCH-NOISE: 100 forward microsleeps, raw noise σ 4° (common to both eyes): ≥ 97 % at 1.0 s + 1 frame (NC-T7d)', () => {
    const res = forward((r) => {
      const v = 4 * gauss(r);
      return { r: v, l: v };
    });
    expect(onTime(res)).toBeGreaterThanOrEqual(97);
  });

  /** Student-t, ν = 3 (a normal over the root of a scaled χ²₃). */
  const t3 = (r: () => number) => {
    const z = gauss(r);
    const chi = gauss(r) ** 2 + gauss(r) ** 2 + gauss(r) ** 2;
    return z / Math.sqrt(chi / 3);
  };
  test('S-FWD-LATCH-HEAVY: 100 forward microsleeps, raw noise Student-t (ν 3, scale 4°), σ̂ 4°: ≥ 97 % at 1.0 s + 1 frame (NC-T7g, NC-T7d)', () => {
    // σ̂ at the review's 4° (the single-frame threshold −27°). Stage 1 would measure a t₃ of scale 4 wider (≈ 6°), which
    // only moves the threshold further out.
    const res = forward((r) => {
      const v = 4 * t3(r);
      return { r: v, l: v };
    });
    expect(onTime(res)).toBeGreaterThanOrEqual(97);
  });

  test('S-ONSET-GLITCH: a one-eye spike on the frame before onset (the combined raw at −30°), in 20 % of forward microsleeps: never latched, F1 at 1.0 s + 1 frame (NC-T7f)', () => {
    const res = forward(() => ({ r: 0, l: 0 }), { glitchEvery: 5, glitch: 'disagree' });
    const glitched = res.filter((x) => x.glitched);
    expect(glitched).toHaveLength(20);
    expect(onTime(glitched)).toBe(20);
  });

  test('the same spike with the other eye usable but unreliable (a partly covered iris): never latched (every usable eye must be reliable)', () => {
    const res = forward(() => ({ r: 0, l: 0 }), { glitchEvery: 5, glitch: 'unreliable' });
    expect(onTime(res.filter((x) => x.glitched))).toBe(20);
  });

  // An eye-mover (head −8°, above the latch's −5° clear pitch would clear it after 300 ms): one reliable raw frame.
  test('the single-frame path does latch a real look down: one reliable frame at −40° (both eyes, head −8°) before a fast lid: F1 at 1.5 s, not 1.0', () => {
    const ps = perceive([...repeat(n(1), () => ({})), { gaze: -40, pitchR: -40, pitchL: -40, head: -8 }, ...repeat(n(2), () => ({ gaze: -40, ear: 0.015, head: -8 }))]);
    const lat = f1Latency(ps, rules(ps))!;
    expect(lat).toBeGreaterThan(ONE_S);
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
  });
});

describe('the frozen gate references (rev2 §2.3.6): pull on the live centres cannot move F1', () => {
  /** S-NODOFF-12's pattern: the head (and gaze) drop to −6° then −12° during the closure. */
  const nodOff = (refs: Partial<ConditionerRefs>) => {
    const ps = perceive(
      [...repeat(n(0.5), () => ({})), ...repeat(n(0.5), () => ({ ear: 0.015, head: -6, gaze: -6 })), ...repeat(n(1), () => ({ ear: 0.015, head: -12, gaze: -12 }))],
      refs
    );
    return f1Latency(ps, rules(ps))!;
  };
  const base = nodOff({});
  test.each([
    ['S-PITCHERR +10°', 10],
    ['S-PITCHERR −10°', -10],
    ['S-BUMP-UP12', 12],
  ])('%s: the live centres off by that much, the gate references right: F1 latency unchanged within 1 frame', (_, err) => {
    const off = { yaw: 0, pitch: err };
    expect(Math.abs(nodOff({ gazeCentre: off, headCentre: off, pitchReference: err }) - base)).toBeLessThanOrEqual(FRAME_MS + 1);
  });
});

describe('C7 round 1 (review-C7 C7-4): a moving F event of an episode never deep is shallow and feeds nothing', () => {
  const run = (ear: number, stopped = false) => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(1.5), () => ({ ear }))]);
    const r = createFastRules(C);
    const ev: FastEvent[] = [];
    for (const p of ps) ev.push(...r.onFrame({ p, ruleSpeedKmh: stopped ? 0 : 60, onRoadGaze: !p.eyesClosed, stopped, fps: FPS }).events);
    for (const e of r.flush()) ev.push(e);
    return { ev, floor: r.fatigueFloor(ps.at(-1)!.tMs) };
  };
  test('a half-closed lid (openness 0.2, never deep) while moving: F1 delivered, shallow, no F4 floor; its episode_end shallow', () => {
    const { ev, floor } = run(0.06);
    const f1 = ev.find((e) => e.kind === 'microsleep');
    expect(f1).toMatchObject({ shallow: true });
    expect(ev.find((e) => e.kind === 'episode_end')).toMatchObject({ shallow: true });
    expect(floor).toBe('none');
  });
  test('a real microsleep (openness 0.05, deep from the start): not shallow, the F4 floor at drowsy', () => {
    const { ev, floor } = run(0.015);
    expect(ev.find((e) => e.kind === 'microsleep')?.shallow).toBeUndefined();
    expect(floor).toBe('drowsy');
  });
  test('stopped events are never marked shallow (their feed is fatigue.stopEventsFeed)', () => {
    const { ev } = run(0.06, true);
    expect(ev.find((e) => e.kind === 'microsleep')?.shallow).toBeUndefined();
  });
});
