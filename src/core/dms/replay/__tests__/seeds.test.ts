// Task C8 (calib-parked design rev2 §2.2, §2.7; rev1 I6, I3.4; review-C6 the T8 carry): seeds and the profile.
// A profile (or C2 seed) seeds the drive, widened (+5°, HUD seed_check, D2 on) until verified against fresh evidence:
// windows of 8 s of seed-admitted weight (≥ 30 km/h, straight or gentle turns), each with its mode, relative
// peakedness and SE; agreeing (primary source and head) → verified; two consecutive peaked windows beyond the agree
// bound that agree with each other → the dual state (cause 'seed'), which commits or reverts by its own rules. A
// Stage 1 pass replaces everything. The start check re-derives a profile EAR that is too low (openness > 1.15),
// never lowers one under the downward rule, and re-derives the MAR outside [0.7, 1.4]. The profile stores the
// appearance its EAR was taken under, and an adoption in another light is corrected by it. Saving: calibrated or
// seed-verified, no dual state or probation pending, health good and the fatigue gate clear for the last 10 min;
// the verified reference EAR/MAR, never the adapted state.
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../../engine/config';
import { explainedFactor } from '../../engine/baselines';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent, type DmsSnapshot } from '../../engine/engine';
import type { DmsProfileV1 } from '../../engine/profile';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const mirrors = (t: number): Partial<DriverState> => (t % 15 >= 5 && t % 15 < 5.8 ? { gaze: rel(27, 10) } : t % 15 >= 11 && t % 15 < 11.8 ? { gaze: rel(-45, 0) } : {});

interface Drive {
  events: (DmsEvent & { cause?: string })[];
  commands: DmsAlertCommand[];
  seconds: { tMs: number; centre: AnglePair | null; calReason: DmsSnapshot['calReason']; distraction: DmsSnapshot['distraction']; earRef: number | null }[];
  profile: DmsProfileV1 | null;
}

function drive(driver: DriverFn, seconds: number, o: { seed?: number; profile?: DmsProfileV1 | null; cfg?: DmsConfig } = {}): Drive {
  const items = synthDrive({ fps: 15, seconds, seed: o.seed ?? 1, source: 'geometric', driver, motion: true });
  const e = createDmsEngine(o.cfg ?? C, { ...DEFAULT_INIT, profile: o.profile ?? null });
  const out: Drive = { events: [], commands: [], seconds: [], profile: null };
  let next = 0;
  for (const it of items) {
    if (it.row !== undefined) e.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    e.pushFrame(it.frame);
    const d = e.drain();
    out.events.push(...d.events);
    out.commands.push(...d.commands);
    if (it.frame.tMs >= next) {
      next += 1000;
      const s = e.snapshot();
      out.seconds.push({ tMs: it.frame.tMs, centre: s.centre.gaze, calReason: s.calReason, distraction: s.distraction, earRef: s.earRef });
    }
  }
  out.profile = e.endDrive(items.at(-1)!.frame.tMs).profile;
  return out;
}
const attentive = (over: (t: number) => Partial<DriverState> | null = () => null, speedKmh = 60): DriverFn => (t, r) => ({ gaze: onRoad(r), openness: blinkOpenness(t), speedKmh, ...mirrors(t), ...(over(t) ?? {}) });
const ev = (d: Drive, kind: string) => d.events.filter((e) => e.kind === kind);
const at = (d: Drive, tMs: number) => [...d.seconds].reverse().find((s) => s.tMs <= tMs)!;
const d1 = (d: Drive) => d.commands.filter((c) => c.kind === 'distraction' && c.action === 'start');

/** A profile from a 5 min attentive drive (seed 1): the truth for the seed tests. */
let PROFILE: DmsProfileV1;
beforeAll(() => {
  PROFILE = drive(attentive(), 300).profile!;
});

describe('seed verification (rev2 §2.2; NC-C8-S1)', () => {
  test('the profile of a clean drive is saved, with its appearance and σ̂ (the T8 carry)', () => {
    expect(PROFILE).not.toBeNull();
    expect(PROFILE.earAppearance).toBeDefined();
    expect(PROFILE.earAppearance!.faceLuma).toBeGreaterThan(0);
    expect(PROFILE.sigmaDeg).toBeDefined();
  });
  test('S-SEED-GOOD: 20 drives on a matching profile at σ 4°: verified within 60 s, the seed discarded in ≤ 1 (≤ 5 %)', () => {
    let discarded = 0;
    for (let seed = 2; seed <= 21; seed++) {
      const d = drive(attentive(), 70, { seed, profile: PROFILE });
      expect(ev(d, 'warm_start')).toHaveLength(1);
      const verified = ev(d, 'seed_verified');
      if (ev(d, 'posture_dual').some((e) => e.cause === 'seed')) discarded++;
      else {
        expect(verified).toHaveLength(1);
        expect(verified[0]!.tMs).toBeLessThanOrEqual(60_000);
      }
    }
    expect(discarded).toBeLessThanOrEqual(1);
  });
  test('while unverified: the zones widened and the HUD says seed_check; after it, the warm-up aside, not', () => {
    const d = drive(attentive(), 150, { seed: 3, profile: PROFILE });
    const v = ev(d, 'seed_verified')[0]!;
    const w = ev(d, 'warm_start')[0]!;
    expect(at(d, (w.tMs + v.tMs) / 2 + 500).calReason).toBe('seed_check');
    expect(at(d, v.tMs + 1500).calReason).toBeNull();
    expect(at(d, 140_000).distraction).toBe('full');
  });
  // A single disagreeing window is not a discard (NC-C8-S1): a stare that fills about one window, then the road.
  test('S-SEED-GLANCE: one window at a navigation screen, then the road: verified, never the dual state', () => {
    const nav = rel(12, -10);
    const d = drive(attentive((t) => (t >= 5 && t < 12.5 ? { gaze: nav } : null)), 70, { seed: 15, profile: PROFILE });
    expect(ev(d, 'posture_dual').filter((e) => e.cause === 'seed')).toEqual([]);
    expect(ev(d, 'seed_verified')).toHaveLength(1);
    expect(ev(d, 'seed_verified')[0]!.tMs).toBeLessThanOrEqual(60_000);
  });
  // Roads that are never straight (a steady 4°/s turn): no seed window and no Stage 1 admission, so the seed stays
  // unverified past the warm-up: the zones stay widened and the HUD says seed_check (NC-C8-W).
  test('S-SEED-CURVES: a seed unverified past the warm-up without a Stage 1 pass stays widened, seed_check', () => {
    const d = drive(attentive(() => ({ turnDegS: 4 })), 150, { seed: 16, profile: PROFILE });
    expect(ev(d, 'seed_verified')).toEqual([]);
    expect(ev(d, 'calibrated')).toEqual([]);
    for (const tMs of [80_000, 110_000, 140_000]) {
      expect(at(d, tMs).distraction).toBe('widened');
      expect(at(d, tMs).calReason).toBe('seed_check');
    }
  });
  test('S-SEED-STARE: a 25 s stare at a navigation screen at the start cannot replace a good seed', () => {
    const nav = rel(12, -10);
    const d = drive(attentive((t) => (t < 30 ? { gaze: nav } : null)), 200, { seed: 4, profile: PROFILE });
    expect(ev(d, 'posture_commit')).toEqual([]);
    const truth = PROFILE.gazeCentres.geometric!;
    expect(angularDistanceDeg(at(d, 199_000).centre!, truth)).toBeLessThanOrEqual(1.5);
  });
  test('S-STALE: a profile 8° off (and its EAR 20 % high): rejected by two disagreeing windows (dual, cause seed), replaced, 0 false D1', () => {
    const g = PROFILE.gazeCentres.geometric!;
    const stale: DmsProfileV1 = {
      ...PROFILE,
      gazeCentres: { geometric: { yaw: g.yaw + 8, pitch: g.pitch } },
      headCentre: { yaw: PROFILE.headCentre.yaw + 8, pitch: PROFILE.headCentre.pitch },
      openEyeEar: [PROFILE.openEyeEar[0]! * 1.2, PROFILE.openEyeEar[1]! * 1.2],
    };
    const d = drive(attentive(), 240, { seed: 5, profile: stale });
    const dual = ev(d, 'posture_dual').filter((e) => e.cause === 'seed');
    expect(dual).toHaveLength(1);
    expect(dual[0]!.tMs).toBeLessThanOrEqual(60_000);
    expect(ev(d, 'seed_verified')).toEqual([]);
    expect(angularDistanceDeg(at(d, 239_000).centre!, g)).toBeLessThanOrEqual(1.5);
    expect(d1(d)).toEqual([]);
  });
});

describe('the start check on a profile EAR and MAR (rev2 §2.2 item 3, I3.4)', () => {
  test('an EAR 30 % low (openness ≈ 1.4 > 1.15) is re-derived upward within the first 30 s of driving', () => {
    const low: DmsProfileV1 = { ...PROFILE, openEyeEar: [PROFILE.openEyeEar[0]! * 0.7, PROFILE.openEyeEar[1]! * 0.7] };
    const d = drive(attentive(), 60, { seed: 6, profile: low });
    expect(ev(d, 'baseline_reset').length).toBeGreaterThanOrEqual(1);
    expect(at(d, 30_000).earRef!).toBeGreaterThanOrEqual(0.3 * 0.97);
  });
  test('an EAR twice too high (openness ≈ 0.5 < 0.6) is never lowered by it (the downward rule): the profile floor holds', () => {
    const high: DmsProfileV1 = { ...PROFILE, openEyeEar: [PROFILE.openEyeEar[0]! * 2, PROFILE.openEyeEar[1]! * 2] };
    const d = drive(attentive(), 50, { seed: 7, profile: high });
    expect(at(d, 49_000).earRef!).toBeGreaterThanOrEqual(0.85 * 0.6 * 0.99);
  });
  test('a MAR twice the driver\'s (the median ratio 0.5 < 0.7) is re-derived at the start', () => {
    const wide: DmsProfileV1 = { ...PROFILE, neutralMar: PROFILE.neutralMar * 2 };
    const d = drive(attentive(), 50, { seed: 8, profile: wide });
    expect(ev(d, 'baseline_reset').length).toBeGreaterThanOrEqual(1);
  });
});

describe('the profile appearance (the review-C6 T8 carry; NC-C8-A)', () => {
  // The raw EAR follows the face luma by K5's table (the synth's appearance change).
  const earOfLuma = (luma: number) => explainedFactor(C, { luma, iod: 1 });
  // Before any Stage 1 pass (which re-derives everything), the adopted reference is the profile's, with the profile's
  // DAYLIGHT appearance: at dusk (luma 0.5) the change is an appearance event and the reference follows the table.
  // Adopted with the current (dusk) appearance instead (NC-C8-A), it would stay at the daylight value (openness 0.8,
  // inside the start check's range), hiding closures by 20 %.
  test('S-PROFILE-DUSK: a daylight profile adopted at dusk (luma 0.5) is followed down by the luma, before any pass', () => {
    // Stage 1 held off (it would re-derive the reference from the dusk frames): the adopted profile's reference alone.
    const cfg = resolveDmsConfig({ calibration: { firstEvalDrivingS: 1000, giveUpS: 2000 } });
    const d = drive(attentive(() => ({ eyeLuma: 0.5, earScale: earOfLuma(0.5) })), 60, { seed: 9, profile: PROFILE, cfg });
    expect(ev(d, 'calibrated')).toEqual([]);
    expect(ev(d, 'warm_start')).toHaveLength(1);
    const e0 = PROFILE.openEyeEar[0]!;
    expect(Math.abs(at(d, 59_000).earRef! / (e0 * earOfLuma(0.5)) - 1)).toBeLessThanOrEqual(0.03);
  });
});

describe('profile saving (rev2 §2.7; NC-C8-S2)', () => {
  test('the saved EAR is the verified reference, not the adapted state: a drive whose EAR rose ×1.2 saves the start value', () => {
    const d = drive(attentive((t) => (t >= 150 ? { earScale: 1.2 } : null)), 600, { seed: 10 });
    expect(at(d, 599_000).earRef!).toBeGreaterThan(0.3 * 1.15);
    expect(d.profile).not.toBeNull();
    expect(d.profile!.openEyeEar[0]!).toBeLessThanOrEqual(0.3 * 1.03);
  });
  test('a seed-verified drive saves (ended before Stage 1 can evaluate, at 55 s)', () => {
    const d = drive(attentive(), 55, { seed: 11, profile: PROFILE });
    expect(ev(d, 'seed_verified')).toHaveLength(1);
    expect(ev(d, 'calibrated')).toEqual([]);
    expect(d.profile).not.toBeNull();
  });
  test('nothing is saved with the seed unverified (never 30 km/h, and no Stage 1 pass)', () => {
    const d = drive(attentive(undefined, 25), 150, { seed: 12, profile: PROFILE });
    expect(ev(d, 'seed_verified')).toEqual([]);
    expect(ev(d, 'calibrated')).toEqual([]);
    expect(d.profile).toBeNull();
  });
  test('nothing is saved with the fatigue gate set in the last 10 min (a microsleep at 4 min)', () => {
    const d = drive(attentive((t) => (t >= 240 && t < 242 ? { openness: 0.05 } : null)), 400, { seed: 13 });
    expect(ev(d, 'microsleep').length).toBeGreaterThanOrEqual(1);
    expect(d.profile).toBeNull();
  });
  test('nothing is saved with gaze health degraded in the last 10 min (the road 7° up from 4 min, no mirror checks)', () => {
    const d = drive((t, r) => ({ gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 60, ...(t >= 240 ? { posture: { shift: { yaw: 0, pitch: 7 } } } : {}) }), 400, { seed: 14 });
    expect(d.profile).toBeNull();
  });
});
