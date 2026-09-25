// Task C6 (design rev2 §2.3.4, rev1 I3/I4, rev3, rev4 §2.3.9): the eye and mouth baselines. EAR up ≤ 5 %/min;
// down never continuous, only on an appearance event, with the fatigue gate clear and by the explained factor;
// a floor anchored to the drive's start (and the profile), appearance-corrected; the MAR; never inside an
// episode; a continuous unexplained low q/b is fatigue evidence.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../config';
import { createBaselines, explainedFactor, type BaselineInput, type EyeSample } from '../baselines';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const FPS = 15;
const REF = 0.3;

interface Scene {
  ear?: number;
  luma?: number;
  contrast?: number;
  iodC?: number;
  usable?: boolean;
  reliable?: boolean;
  hold?: boolean;
  moving?: boolean;
  mar?: number | null;
  /** the fatigue gate; default: fed back from the baselines' own evidence, as the engine does */
  gate?: boolean;
  blinkEvery?: number;
}

/** Frames at 15 fps from t0 for `seconds`; the EAR has a small texture and a blink every 4 s (excluded by openness). */
function run(b: ReturnType<typeof createBaselines>, scene: (t: number) => Scene, seconds: number, t0 = 0) {
  const out: { t: number; r: number | null; mar: number | null; events: string[] }[] = [];
  for (let i = 0; i < seconds * FPS; i++) {
    const t = t0 + i / FPS;
    const s = scene(t);
    const blink = (t % (s.blinkEvery ?? 4)) < 0.2;
    const ear = (s.ear ?? REF) * (blink ? 0.2 : 1) * (1 + 0.005 * Math.sin(t * 7.1));
    // C6 round 1: the iris contrast follows the lid (∝ √openness), recorded but never an explanation.
    const lidRel = Math.min(1, ear / REF);
    const eye: EyeSample | null = s.usable === false ? null : { ear, contrast: 20 * (s.contrast ?? 1) * Math.sqrt(Math.max(0, lidRel)), usable: true, reliable: s.reliable ?? true };
    const x: BaselineInput = {
      tMs: t * 1000,
      dtS: 1 / FPS,
      moving: s.moving ?? true,
      tracking: true,
      hold: (s.hold ?? false) || blink,
      headYaw: 0,
      headPitchRel: 0,
      r: eye,
      l: eye,
      iodC: 0.2 * (s.iodC ?? 1),
      faceLuma: 100 * (s.luma ?? 1),
      mar: s.mar === undefined ? 0.08 : s.mar,
      fatigueGate: typeof s.gate === 'boolean' ? s.gate : b.lowUnexplained(),
    };
    const o = b.step(x);
    out.push({ t, r: o.ear?.r ?? null, mar: o.mar, events: o.events.map((e) => e.kind) });
  }
  return out;
}
const last = (o: ReturnType<typeof run>) => o[o.length - 1]!;
const fresh = (profileEar: number | null = null) => {
  const b = createBaselines(C, { profileEar: profileEar === null ? null : { r: profileEar, l: profileEar } });
  b.setReference({ r: REF, l: REF }, 0.08, 0);
  return b;
};

describe('C6 baselines: EAR up', () => {
  test('×1.2 is followed up at ≤ 5 %/min: within 4–5 min, never faster', () => {
    const b = fresh();
    const o = run(b, () => ({ ear: REF * 1.2 }), 330);
    const at = (s: number) => o.find((x) => x.t >= s)!.r!;
    expect(at(60)).toBeLessThanOrEqual(REF * 1.051);
    expect(at(150)).toBeLessThanOrEqual(REF * 1.13);
    expect(last(o).r!).toBeGreaterThanOrEqual(REF * 1.19 * 0.99);
  });
  test('capped at +40 % of the drive reference', () => {
    const b = fresh();
    const o = run(b, () => ({ ear: REF * 2 }), 900);
    expect(last(o).r!).toBeLessThanOrEqual(REF * 1.4 + 1e-9);
    expect(last(o).r!).toBeGreaterThan(REF * 1.35);
  });
});

describe('C6 baselines: EAR down only on an explained appearance event (NC-B1, NC-B2)', () => {
  test('S-DROOP (unit): a 10 % drop with no appearance change never lowers the reference, and after 60 s is fatigue evidence (NC-B1)', () => {
    const b = fresh();
    const o = run(b, () => ({ ear: REF * 0.88 }), 300);
    expect(last(o).r).toBe(REF);
    expect(b.lowUnexplained()).toBe(true);
    expect(o.some((x) => x.events.includes('ear_low_unexplained'))).toBe(true);
  });
  test('a luma drop to 0.5 with the EAR at the table factor: the reference follows the explained drop', () => {
    const b = fresh();
    const f = explainedFactor(C, { luma: 0.5, iod: 1 });
    expect(f).toBeCloseTo(0.8, 6);
    const o = run(b, (t) => (t >= 60 ? { ear: REF * f, luma: 0.5 } : {}), 120);
    expect(Math.abs(last(o).r! / (REF * f) - 1)).toBeLessThanOrEqual(0.03);
    expect(o.some((x) => x.events.includes('ear_lowered'))).toBe(true);
    expect(b.lowUnexplained()).toBe(false);
  });
  test('the explained factor only, never the full drop: luma 0.5 (explains 0.8) with the EAR at 0.6 → the reference at 0.8, the rest is fatigue evidence (NC-B2)', () => {
    const b = fresh();
    const o = run(b, (t) => (t >= 60 ? { ear: REF * 0.6, luma: 0.5 } : {}), 120);
    expect(Math.abs(last(o).r! / (REF * 0.8) - 1)).toBeLessThanOrEqual(0.03);
    expect(o.some((x) => x.events.includes('ear_unexplained'))).toBe(true);
  });
  test('the fatigue gate set: an explained drop is not applied', () => {
    const b = fresh();
    const o = run(b, (t) => (t >= 60 ? { ear: REF * 0.8, luma: 0.5, gate: true } : {}), 120);
    expect(last(o).r!).toBeGreaterThanOrEqual(REF * 0.99);
  });
  test('an IOD change of ≥ 5 % is an event, explained by the IOD model', () => {
    const b = fresh();
    const f = explainedFactor(C, { luma: 1, iod: 1.1 });
    const o = run(b, (t) => (t >= 60 ? { ear: REF * f, iodC: 1.1 } : {}), 120);
    expect(o.some((x) => x.events.includes('appearance'))).toBe(true);
    expect(Math.abs(last(o).r! / (REF * f) - 1)).toBeLessThanOrEqual(0.03);
  });
  test('a luma change held under 10 s is no event', () => {
    const b = fresh();
    const o = run(b, (t) => (t >= 60 && t < 68 ? { luma: 0.5 } : {}), 120);
    expect(o.some((x) => x.events.includes('appearance'))).toBe(false);
  });
});

describe('C6 baselines: the floor (NC-B3)', () => {
  test('the drive floor: 0.85 × the start reference, appearance-corrected (a legit dusk goes below it)', () => {
    const b = fresh();
    // six alternating luma steps with a droop underneath: the explained factors cancel, the droop is never taken
    const o = run(b, (t) => ({ ear: REF * (1 - 0.01 * (t / 60)) * (Math.floor(t / 60) % 2 === 1 ? 0.8 : 1), luma: Math.floor(t / 60) % 2 === 1 ? 0.5 : 1 }), 420);
    expect(Math.min(...o.map((x) => x.r!))).toBeGreaterThanOrEqual(0.85 * REF * 0.8 - 1e-9);
    expect(o.filter((x) => Math.floor(x.t / 60) % 2 === 0 && x.t % 60 > 30).every((x) => x.r! >= 0.85 * REF)).toBe(true);
  });
  test('the profile anchor: a reference set below 0.85 × the profile EAR is raised to it (NC-B3)', () => {
    const b = createBaselines(C, { profileEar: { r: 0.32, l: 0.32 } });
    const set = b.setReference({ r: 0.2, l: 0.2 }, 0.08, 0);
    expect(set.r).toBeCloseTo(0.85 * 0.32, 9);
  });
  test('without a profile a low start is kept (the stated residual)', () => {
    const b = createBaselines(C, { profileEar: null });
    expect(b.setReference({ r: 0.2, l: 0.2 }, 0.08, 0).r).toBeCloseTo(0.2, 9);
  });
});

describe('C6 baselines: offered values (the resume paths, R4)', () => {
  test('up is taken; down only with the gate clear and by the explained factor', () => {
    const b = fresh();
    run(b, () => ({}), 30);
    expect(b.offer({ r: REF * 1.1, l: REF * 1.1 }, { luma: 100, iodC: 0.2 }).r).toBeCloseTo(REF * 1.1, 9);
    const b2 = fresh();
    run(b2, () => ({}), 30);
    expect(b2.offer({ r: REF * 0.6, l: REF * 0.6 }, { luma: 100, iodC: 0.2 }).r!).toBeGreaterThanOrEqual(REF);
    const b3 = fresh();
    run(b3, () => ({}), 30);
    const was3 = b3.offer({ r: REF * 2, l: REF * 2 }, null).r! / 2 / REF; // (a no-op probe of the current reference: up to the cap)
    expect(was3).toBeGreaterThan(0);
    const b3b = fresh();
    run(b3b, () => ({}), 30);
    const cur = b3b.offer({ r: 0, l: 0 }, null, true).r!; // the gate set: a down offer returns the current reference
    expect(b3b.offer({ r: REF * 0.6, l: REF * 0.6 }, { luma: 50, iodC: 0.2 }).r).toBeCloseTo(cur * 0.8, 6);
    const b4 = fresh();
    run(b4, () => ({ gate: true }), 30);
    expect(b4.offer({ r: REF * 0.6, l: REF * 0.6 }, { luma: 50, iodC: 0.2 }, true).r!).toBeGreaterThanOrEqual(REF);
  });
});

describe('C6 baselines: never inside an episode, never stopped', () => {
  test('stopped frames are not eligible: a stop-time ×1.2 changes nothing', () => {
    const b = fresh();
    const o = run(b, () => ({ ear: REF * 1.2, moving: false }), 300);
    expect(last(o).r).toBe(REF);
  });
  test('a boundary inside an episode is skipped', () => {
    const b = fresh();
    const o = run(b, () => ({ ear: REF * 1.2, hold: true }), 120);
    expect(last(o).r).toBe(REF);
  });
});

describe('C6 baselines: the MAR', () => {
  test('up ≤ 3 %/min and ≤ +20 % per 10 min; down ≤ 5 %/min with the floor', () => {
    const b = fresh();
    const up = run(b, () => ({ mar: 0.11 }), 600); // below the talking bound (1.5 × 0.08 = 0.12)
    expect(last(up).mar!).toBeLessThanOrEqual(0.08 * 1.2 + 1e-9);
    const b2 = fresh();
    const down = run(b2, () => ({ mar: 0.01 }), 120);
    expect(last(down).mar!).toBeGreaterThanOrEqual(0.08 * (1 - 0.05 * 2) - 1e-6);
    expect(last(down).mar!).toBeGreaterThanOrEqual(C.calibration.neutralMarFloor);
  });
  test('never up with a yawn in the last 5 min', () => {
    const b = fresh();
    b.onYawn(10_000);
    const o = run(b, () => ({ mar: 0.1 }), 240);
    expect(last(o).mar).toBeCloseTo(0.08, 9);
  });
  test('talking is excluded (MAR above 1.5 × neutral)', () => {
    const b = fresh();
    const o = run(b, () => ({ mar: 0.3 }), 300);
    expect(last(o).mar).toBeCloseTo(0.08, 9);
  });
});

describe('C6 baselines: no reference yet (S-G, the tier change)', () => {
  test('the eyes becoming usable give a reference 10 s later (sunglasses off)', () => {
    const b = createBaselines(C, { profileEar: null });
    const o = run(b, (t) => (t < 60 ? { usable: false } : {}), 80);
    const got = o.find((x) => x.r !== null);
    expect(got).toBeDefined();
    expect(got!.t).toBeLessThanOrEqual(72);
    expect(Math.abs(got!.r! / REF - 1)).toBeLessThanOrEqual(0.05);
  });
});

describe('C6 round 1 (review-C6 C6-1): only lid-independent evidence explains a drop (NC-C6-X, NC-C6-T)', () => {
  test('S-DROOP-CONTRAST: a 1 %/min droop, the iris contrast falling with the lid, the reliable tier lost at 7 min, no profile: the reference ≥ 0.99 × the start; the gate set by 11 min', () => {
    const b = fresh();
    let gateAt: number | null = null;
    const o = run(b, (t) => ({ ear: REF * (1 - 0.01 * (t / 60)), reliable: t < 420 }), 900);
    for (const x of o) if (gateAt === null && b.lowUnexplained() && x.t > 0) gateAt = x.t;
    const minR = Math.min(...o.map((x) => x.r!));
    expect(minR).toBeGreaterThanOrEqual(0.99 * REF);
    // the gate: the evidence set (an unexplained drop at the tier event, or the low q/b held 60 s) by 11 min
    const firstEvidence = o.find((x) => x.events.includes('ear_unexplained') || x.events.includes('ear_low_unexplained'));
    expect(firstEvidence).toBeDefined();
    expect(firstEvidence!.t).toBeLessThanOrEqual(660);
    expect(o.some((x) => x.events.includes('ear_lowered'))).toBe(false);
    void gateAt;
  });
  test('a lone tier loss (the face luma and the IOD unchanged) with a lower EAR is fatigue evidence, never a lower reference', () => {
    const b = fresh();
    const o = run(b, (t) => (t >= 60 ? { ear: REF * 0.85, reliable: false } : {}), 120);
    expect(last(o).r!).toBeGreaterThanOrEqual(REF * 0.99);
    expect(o.some((x) => x.events.includes('ear_unexplained'))).toBe(true);
  });
  test('sunglasses on (the face luma of the eye region down ≥ 25 %) with the tier change: explained by the luma, followed', () => {
    const b = fresh();
    const f = explainedFactor(C, { luma: 0.7, iod: 1 });
    const o = run(b, (t) => (t >= 60 ? { ear: REF * f, reliable: false, luma: 0.7 } : {}), 120);
    expect(Math.abs(last(o).r! / (REF * f) - 1)).toBeLessThanOrEqual(0.03);
  });
});
