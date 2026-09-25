// Task C6 (design rev2 §2.3.4, §2.3.5, §2.3.7; rev1 I3/I4; rev3; rev4 §2.3.9 S4): the eye baselines through the
// engine façade. The EAR follows up, and down only on an explained appearance event; a droop is never followed and
// is fatigue evidence; the floor holds against a ratchet and a drowsy start (with a profile); a drowsy resume never
// lowers it; the collectors never take stop-time frames.
import { explainedFactor } from '../../engine/baselines';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent } from '../../engine/engine';
import type { DmsProfileV1 } from '../../engine/profile';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

function drv(over: (t: number, r: () => number) => Partial<DriverState> | null, speedKmh = 60): DriverFn {
  return (t, r) => {
    const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh };
    const o = over(t, r);
    return o === null ? base : { ...base, ...o };
  };
}

interface Run {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  /** once a second */
  seconds: { tMs: number; earRef: number | null; pitchRef: number | null; fatigueGate: boolean; earEvidence: boolean; level: string; eyes: 'good' | 'degraded' }[];
}

function play(driver: DriverFn, seconds: number, o: { fps?: number; cfg?: DmsConfig; seed?: number; profile?: DmsProfileV1 | null; lidGaze?: boolean } = {}): Run {
  const items = synthDrive({ fps: o.fps ?? 15, seconds, seed: o.seed ?? 21, source: 'geometric', driver, motion: true, lidGaze: o.lidGaze });
  const engine = createDmsEngine(o.cfg ?? C, { ...DEFAULT_INIT, profile: o.profile ?? null });
  const run: Run = { events: [], commands: [], seconds: [] };
  let next = 0;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const out = engine.drain();
    run.events.push(...out.events);
    run.commands.push(...out.commands);
    if (it.frame.tMs >= next) {
      next += 1000;
      const s = engine.snapshot();
      run.seconds.push({ tMs: it.frame.tMs, earRef: s.earRef, pitchRef: s.pitchReference, fatigueGate: s.fatigueGate, earEvidence: s.earEvidence, level: s.fatigueLevel, eyes: s.health.eyes });
    }
  }
  return run;
}
const at = (r: Run, tMs: number) => [...r.seconds].reverse().find((s) => s.tMs <= tMs)!;
const kinds = (r: Run, k: string) => r.events.filter((e) => e.kind === k);
const levels = (r: Run) => r.events.filter((e) => e.kind === 'fatigue_minute').map((e) => (e as { level?: string }).level);
/** The EAR factor the synth's appearance change carries (consistent with K5's table, the device item). */
const earOfLuma = (luma: number) => explainedFactor(C, { luma, iod: 1 });

describe('S-L1 / S-L2: the EAR follows an appearance change, and fatigue does not rise (rev1 I3/I4; NC-B2, NC-R5)', () => {
  /** Dusk from 120 s to 420 s: the eye luma 1 → 0.5, the raw EAR with it (×0.8 at the end). */
  const dusk = (t: number) => (t < 120 ? 1 : t < 420 ? 1 - (0.5 * (t - 120)) / 300 : 0.5);
  test('S-L1: dusk (luma 0.5, EAR ×0.8): the reference follows within 10 min (±5 %); 0 false F1; no fatigue level', () => {
    const r = play(drv((t) => ({ eyeLuma: dusk(t), earScale: earOfLuma(dusk(t)) })), 1020);
    const e0 = at(r, 110_000).earRef!;
    expect(Math.abs(at(r, 1019_000).earRef! / (e0 * 0.8) - 1)).toBeLessThanOrEqual(0.05);
    expect(kinds(r, 'microsleep')).toEqual([]);
    expect(levels(r).every((l) => l === 'none')).toBe(true);
  });
  test('S-L1 closures: injected 1.3 s closures after the dusk are all detected', () => {
    const shut = (t: number) => t >= 480 && (t - 480) % 90 < 1.3;
    const r = play(drv((t) => ({ eyeLuma: dusk(t), earScale: earOfLuma(dusk(t)), ...(shut(t) ? { openness: 0.1 } : {}) })), 840);
    const injected = [480, 570, 660, 750];
    const ms = kinds(r, 'microsleep').map((e) => e.tMs / 1000);
    for (const t0 of injected) expect(ms.some((t) => t >= t0 && t < t0 + 3)).toBe(true);
  });
  test('S-L2: EAR ×1.2 from 120 s (no appearance change): followed up within 5 min (≤ 5 %/min), no fatigue level', () => {
    const r = play(drv((t) => (t >= 120 ? { earScale: 1.2 } : null)), 900);
    const e0 = at(r, 110_000).earRef!;
    expect(at(r, 180_000).earRef!).toBeLessThanOrEqual(e0 * 1.06); // never faster than 5 %/min
    expect(Math.abs(at(r, 420_000).earRef! / (e0 * 1.2) - 1)).toBeLessThanOrEqual(0.02);
    expect(levels(r).every((l) => l === 'none')).toBe(true);
  });
});

describe('S-G: sunglasses off after 10 min (NC-C6-G)', () => {
  // C6 round 1 (C6-2): 13 s, was 12 s. Before the reference exists the prior sees the blinks as closures, and closure
  // frames are hold frames, so the 10 s check's eligible time now excludes the blinks' share (5 %).
  test('re-baselined within 13 s of the lens coming off; 0 false F1', () => {
    const r = play(drv((t) => (t < 600 ? { lens: true } : null)), 720);
    expect(at(r, 599_000).earRef).toBeNull();
    const got = r.seconds.find((s) => s.tMs >= 600_000 && s.earRef !== null);
    expect(got).toBeDefined();
    expect(got!.tMs).toBeLessThanOrEqual(613_000);
    expect(kinds(r, 'microsleep')).toEqual([]);
  });
});

describe('S-DROOP60 and S-NIGHT-RATCHET: a droop is never followed down (NC-B1, NC-C6-E)', () => {
  test('S-DROOP60: a 1 %/min droop for 60 min with no PERCLOS rise: the reference falls ≤ 2 %; the fatigue gate is set', () => {
    // C6 round 1: the droop is the LID (openness), so the synth's iris contrast and eye luma fall with it.
    const r = play(drv((t) => (t >= 120 ? { openness: blinkOpenness(t) * (1 - 0.01 * ((t - 120) / 60)) } : null)), 120 + 3600);
    const e0 = at(r, 110_000).earRef!;
    const min = Math.min(...r.seconds.filter((s) => s.tMs > 120_000).map((s) => s.earRef!));
    expect(min).toBeGreaterThanOrEqual(e0 * 0.98);
    // The q/b ≤ 0.9 from about 11 min (a 10 % droop, held 60 s): fatigue evidence, the gate set, to the end.
    expect(at(r, 120_000 + 540_000).earEvidence).toBe(false);
    for (const tS of [900, 1800, 2700, 3600]) {
      expect(at(r, 120_000 + tS * 1000).earEvidence).toBe(true);
      expect(at(r, 120_000 + tS * 1000).fatigueGate).toBe(true);
    }
    // Task C7 (H5, NC-K2b): a downward ratio alone is fatigue evidence, never "eye tracking limited".
    expect(r.seconds.every((s) => s.eyes === 'good')).toBe(true);
  });
  test('S-NIGHT-RATCHET: a droop plus 6 luma steps (tunnels): the reference ≥ 0.85 × the start value always, back at full luma', () => {
    // Luma 0.6 in minutes 3–5, 9–11, 15–17 (6 steps), the raw EAR with it; a 0.5 %/min droop underneath.
    const dark = (t: number) => t >= 120 && Math.floor((t - 120) / 120) % 3 === 1;
    const lumaOf = (t: number) => (dark(t) ? 0.6 : 1);
    const r = play(drv((t) => (t >= 120 ? { eyeLuma: lumaOf(t), earScale: earOfLuma(lumaOf(t)), openness: blinkOpenness(t) * (1 - 0.005 * ((t - 120) / 60)) } : null)), 120 + 1260);
    const e0 = at(r, 110_000).earRef!;
    const bright = r.seconds.filter((s) => s.tMs > 130_000 && !dark(s.tMs / 1000) && !dark(s.tMs / 1000 - 30));
    expect(bright.length).toBeGreaterThan(100);
    expect(Math.min(...bright.map((s) => s.earRef!))).toBeGreaterThanOrEqual(0.85 * e0);
  });
});

describe('S-DROWSY-START: a drive starting drooped (NC-B3)', () => {
  const PROFILE: DmsProfileV1 = {
    v: 1,
    driverSide: 'left',
    orientation: 90,
    mount: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, boxCx: 0.5, boxCy: 0.45, iod: 0.2 },
    gazeCentres: { geometric: { yaw: 2, pitch: -3 } },
    headCentre: { yaw: 0.8, pitch: -1.2 },
    rollOffsetDeg: 0,
    radiusDeg: 8,
    openEyeEar: [0.3, 0.3],
    neutralMar: 0.08,
    neutralMouthW: 0.9,
    learnedZones: [],
    savedAtMs: 1,
  };
  /** The EAR at ×0.8 of the alert profile's from the start; 1.3 s closures from 200 s every 90 s. */
  const drooped = drv((t) => ({ earScale: 0.8, ...(t >= 200 && (t - 200) % 90 < 1.3 ? { openness: 0.1 } : {}) }));
  test('with a profile: the reference is floored at 0.85 × the profile EAR, and the closures are detected', () => {
    const r = play(drooped, 480, { profile: PROFILE });
    const refs = r.seconds.filter((s) => s.tMs > 90_000 && s.earRef !== null).map((s) => s.earRef!);
    expect(Math.min(...refs)).toBeGreaterThanOrEqual(0.85 * 0.3 - 1e-9);
    const ms = kinds(r, 'microsleep').map((e) => e.tMs / 1000);
    for (const t0 of [200, 290, 380]) expect(ms.some((t) => t >= t0 && t < t0 + 3)).toBe(true);
  });
  test('without one (the stated residual): the reference is the drooped value', () => {
    const r = play(drooped, 480);
    const e = at(r, 470_000).earRef!;
    expect(Math.abs(e / (0.3 * 0.8) - 1)).toBeLessThanOrEqual(0.03);
  });
});

describe('S-RED-DROWSY: a heavy droop over 10 resumes never lowers the reference (R4; NC-R4b)', () => {
  // The resume check runs after a gap while moving (a long search: the face lost ≥ 30 s). At a stop there is no
  // resume check since C4 (a stop is one episode), and T3 keeps the camera on at lights; so the design's "10 lights"
  // are 10 long searches here, each followed by the eyes at half (a heavy droop) as the face returns.
  test('10 × (the face lost 35 s, then the eyes at half for 30 s): each resume check resets, and the reference never falls', () => {
    const gone = (t: number) => t >= 120 && (t - 120) % 120 < 35;
    const drowsyAfter = (t: number) => t >= 120 && (t - 120) % 120 >= 35 && (t - 120) % 120 < 65;
    const r = play(drv((t) => ({ ...(gone(t) ? { face: false } : {}), ...(drowsyAfter(t) ? { earScale: 0.5 } : {}) })), 120 + 1200);
    expect(kinds(r, 'baseline_reset').length).toBeGreaterThanOrEqual(5);
    const e0 = at(r, 110_000).earRef!;
    const min = Math.min(...r.seconds.filter((s) => s.tMs > 120_000 && s.earRef !== null).map((s) => s.earRef!));
    expect(min).toBeGreaterThanOrEqual(e0 * 0.99);
  });
});

describe('S-TOWN-START: 6 lights with phone reading in the first 3 min (rev4 S4; NC-S4)', () => {
  test('the provisional EAR within 5 % of the moving-time p90, the pitch reference within 2°, 0 sleep Criticals', () => {
    // Lights of 15 s every 30 s from 5 s; at each the driver reads a lap phone (the lid follows the gaze down).
    const light = (t: number) => t >= 5 && t < 185 && (t - 5) % 30 < 15;
    const r = play(drv((t) => (light(t) ? { speedKmh: 0, gaze: rel(0, -40), head: { yaw: 0.4, pitch: -1.2 - 20 } } : null), 30), 240, { lidGaze: true });
    const e = at(r, 200_000).earRef!;
    expect(Math.abs(e / 0.3 - 1)).toBeLessThanOrEqual(0.05);
    const pr = r.seconds.filter((s) => s.tMs > 20_000 && s.tMs < 60_000 && s.pitchRef !== null).map((s) => s.pitchRef!);
    expect(pr.length).toBeGreaterThan(0);
    for (const p of pr) expect(Math.abs(p - -1.2)).toBeLessThanOrEqual(2);
    expect(r.commands.filter((c) => c.tier === 3 && c.action === 'start')).toEqual([]);
  });
});
