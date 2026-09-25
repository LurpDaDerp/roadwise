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
}

function perceive(frames: Frm[], refs: Partial<ConditionerRefs> = {}): Perceived[] {
  const c = createConditioner(C);
  return frames.map((x, i) => {
    const head = x.head ?? 0;
    const gaze = x.gaze ?? 0;
    const ear = x.ear ?? 0.3;
    const spec: FrameSpec = { tMs: i * FRAME_MS, head: { yaw: 0, pitch: head, roll: 0 }, gaze: { yaw: 0, pitch: gaze }, ear: [ear, ear] };
    const open = ear > 0.1;
    if (open && x.pitchR !== undefined) spec.eyeR = { oy: oyFor(x.pitchR, head) };
    if (open && x.pitchL !== undefined) spec.eyeL = { oy: oyFor(x.pitchL, head) };
    if (open && x.leftUnreliable === true) spec.eyeL = { ...(spec.eyeL ?? {}), irisContrast: 2, irisIn: false };
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
  test('S-NODOFF-LIGHT-LEVEL: stopped, head level, lids to 0.05: F1 at 1.0 s + 1 frame', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2), () => ({ ear: 0.015 }))]);
    expect(f1Latency(ps, rules(ps, { stopped: true, speed: 0 }))!).toBeLessThanOrEqual(ONE_S);
  });
  test('S-NODOFF-LIGHT-DIP: stopped, the head dips to −7° within 0.5 s, lids to 0.05: F1 ≤ 1.5 s + 1 frame (R-b latches: the +0.5 s cost)', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2.5), (i) => { const h = -7 * Math.min(1, i / n(0.5)); return { ear: 0.015, head: h, gaze: h }; })]);
    const lat = f1Latency(ps, rules(ps, { stopped: true, speed: 0 }))!;
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
    expect(lat).toBeGreaterThan(ONE_S);
  });
  test('while moving R-b is off (NC-T7c): the same dip gives F1 at 1.0 s + 1 frame', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(2.5), (i) => { const h = -7 * Math.min(1, i / n(0.5)); return { ear: 0.015, head: h, gaze: h }; })]);
    expect(f1Latency(ps, rules(ps))!).toBeLessThanOrEqual(ONE_S);
  });
});

describe('R-a: the raw gaze, the noise guard and the single-frame path (the T7 pre-ruling)', () => {
  test('S-NODOFF-GAZE-DROP: the gaze falls to −30° within 0.3 s (head level), then the lids close to 0.05: F1 ≤ 1.5 s + 1 frame', () => {
    const ps = perceive([...repeat(n(1), () => ({})), ...repeat(n(0.3), (i) => ({ gaze: (-30 * (i + 1)) / n(0.3) })), ...repeat(n(0.2), () => ({ gaze: -30 })), ...repeat(n(2), () => ({ gaze: -30, ear: 0.015 }))]);
    const lat = f1Latency(ps, rules(ps))!;
    expect(lat).toBeLessThanOrEqual(ONE_HALF_S);
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
