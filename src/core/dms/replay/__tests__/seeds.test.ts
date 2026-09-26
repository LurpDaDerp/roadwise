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
  // C8 round 1 (review-C8 C8-2): a reference only ever raised since it was set is saved as raised; a downward
  // adaptation is never saved (the reference as set is).
  test('the saved EAR is never a downward adaptation: a dusk drive whose reference followed the luma down saves the start value (NC-C8-S2)', () => {
    const earOfLuma = (luma: number) => explainedFactor(C, { luma, iod: 1 });
    const d = drive(attentive((t) => (t >= 150 ? { eyeLuma: 0.5, earScale: earOfLuma(0.5) } : null)), 900, { seed: 10 });
    expect(at(d, 899_000).earRef!).toBeLessThan(0.3 * earOfLuma(0.5) * 1.05);
    expect(d.profile).not.toBeNull();
    expect(Math.abs(d.profile!.openEyeEar[0]! / 0.3 - 1)).toBeLessThanOrEqual(0.03);
  });
  test('a reference only ever raised is saved as raised: a drive whose EAR rose ×1.2 saves the raised value', () => {
    const d = drive(attentive((t) => (t >= 150 ? { earScale: 1.2 } : null)), 600, { seed: 10 });
    expect(at(d, 599_000).earRef!).toBeGreaterThan(0.3 * 1.15);
    expect(d.profile).not.toBeNull();
    expect(d.profile!.openEyeEar[0]!).toBeGreaterThan(0.3 * 1.15);
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

// ---------------------------------------------------------------------------------------------------------
// C8 round 1 (review-C8): the warm start retries (C8-1), a drowsy start's EAR is not saved (C8-2), a seed moved onto
// a display's direction does not verify (C8-3), and a stale profile through a town drive (the S-SEED-TOWN carry).
// ---------------------------------------------------------------------------------------------------------

describe('S-WARM-TEXTING (review-C8 C8-1; NC-C8-R): a reading start does not throw a good profile away', () => {
  // A good profile at 60 km/h; the first 0, 20 or 40 s spent reading 8.5 s of every 10 s at a target.
  const TARGETS: [string, AnglePair][] = [
    ['the lap (0°, −35°)', rel(0, -35)],
    ['the lap side (10°, −30°)', rel(10, -30)],
    ['a held-up phone (8°, −18°)', rel(8, -18)],
    ['a navigation screen (14°, −8°)', rel(14, -8)],
  ];
  const cases: [number, string, AnglePair][] = [];
  for (const readS of [0, 20, 40]) for (const [n, g] of TARGETS) cases.push([readS, n, g]);
  test.each(cases)('%i s of reading at %s: warm_start ≤ 15 s after it, verified ≤ 60 s after that', (readS, name, target) => {
    const d = drive(attentive((t) => (t < readS && t % 10 < 8.5 ? { gaze: target } : null)), 150, { seed: 30, profile: PROFILE });
    const w = ev(d, 'warm_start');
    expect(w).toHaveLength(1);
    expect(w[0]!.tMs).toBeLessThanOrEqual((readS + 15) * 1000);
    const v = ev(d, 'seed_verified');
    expect(v).toHaveLength(1);
    expect(v[0]!.tMs).toBeLessThanOrEqual(w[0]!.tMs + 60_000);
    if (readS === 40 && name.startsWith('a navigation')) {
      expect(angularDistanceDeg(at(d, 149_000).centre!, PROFILE.gazeCentres.geometric!)).toBeLessThanOrEqual(1.5);
    }
  });
  test('the 40 s navigation start through 240 s: the centre stays within 1.5° of the truth', () => {
    const d = drive(attentive((t) => (t < 40 && t % 10 < 8.5 ? { gaze: rel(14, -8) } : null)), 240, { seed: 30, profile: PROFILE });
    const truth = PROFILE.gazeCentres.geometric!;
    for (const tMs of [60_000, 120_000, 239_000]) expect(angularDistanceDeg(at(d, tMs).centre!, truth)).toBeLessThanOrEqual(1.5);
  });
  test('S-WARM-MOVED: a different face (a real mismatch) is never adopted, through the retries', () => {
    const d = drive((t, r) => ({ ...attentive()(t, r), otherDriver: true }), 360, { seed: 31, profile: PROFILE });
    expect(ev(d, 'warm_start')).toEqual([]);
  });
});

describe('S-SAVE-DROWSY-START (review-C8 C8-2; NC-C8-S3): a drowsy start does not save its drooped EAR', () => {
  // No profile, 90 km/h. For the first 300 s the open lid droops to `droop` with slow 0.7 s closures every 9 s (the
  // review's probe: under 1 s, so no F1, and fatigue is still learning); then 20 min alert.
  test.each([0.9, 0.85, 0.75])('droop %f: the profile saves the true EAR within 3 %%', (droop) => {
    const d = drive(
      attentive((t) => (t < 300 ? { openness: t % 9 < 0.7 ? 0.1 : droop * blinkOpenness(t) } : null), 90),
      1500,
      { seed: 32 }
    );
    expect(ev(d, 'calibrated').length).toBeGreaterThanOrEqual(1);
    expect(ev(d, 'microsleep')).toEqual([]);
    expect(d.profile).not.toBeNull();
    for (const e of d.profile!.openEyeEar) expect(Math.abs(e! / 0.3 - 1)).toBeLessThanOrEqual(0.03);
  });
});

describe("S-SEED-DISPLAY-POSE (review-C8 C8-3; NC-C8-H): a seed moved onto a display's direction with the head unchanged never verifies", () => {
  // The phone on the dash 25° right of and 15° below the road (off it, as a real mount is: with the synth's default
  // camera beside the road, a road 16° from c₀ reads as the phone and no dual candidate forms). The profile is this
  // mount's, its gaze centre moved onto the navigation screen, the head centre unchanged.
  const MOUNT: AnglePair = { yaw: -25, pitch: 15 };
  const mounted = (over: (t: number) => Partial<DriverState> | null = () => null): DriverFn => (t, r) => ({ ...attentive(over)(t, r), mountShift: MOUNT });
  let P: DmsProfileV1;
  beforeAll(() => {
    P = drive(mounted(), 300).profile!;
  });
  // The warm start matches on the first 12 s of road (the head's signature is the profile's), then 60 s at the
  // navigation screen, 8.5 s of every 10 s: every window's gaze mode sits on the moved seed; only the head (40 % of
  // the gaze, 6.4° off its seed) disagrees (NC-C8-H drops the head from the agree test and verifies here). Stage 1 is
  // held off: a navigation-heavy minute would calibrate Stage 1 onto the screen (the review's Stage 1 carry, outside
  // the seed rules); this pins the seed verification alone.
  test('adopted, then a navigation-heavy minute: never verified; the road then replaces the seed (dual, cause seed)', () => {
    const nav = rel(14, -8);
    const g = P.gazeCentres.geometric!;
    const moved: DmsProfileV1 = { ...P, gazeCentres: { geometric: { yaw: g.yaw + 14, pitch: g.pitch - 8 } } };
    const cfg = resolveDmsConfig({ calibration: { firstEvalDrivingS: 1000, giveUpS: 2000 } });
    const d = drive(mounted((t) => (t >= 12 && t < 72 && (t - 12) % 10 < 8.5 ? { gaze: nav } : null)), 240, { seed: 33, profile: moved, cfg });
    expect(ev(d, 'warm_start')).toHaveLength(1);
    expect(ev(d, 'warm_start')[0]!.tMs).toBeLessThanOrEqual(12_000);
    expect(ev(d, 'seed_verified')).toEqual([]);
    expect(ev(d, 'posture_dual').filter((e) => e.cause === 'seed').length).toBeGreaterThanOrEqual(1);
    expect(angularDistanceDeg(at(d, 239_000).centre!, g)).toBeLessThanOrEqual(1.5);
  });
});

describe('S-SEED-TOWN (the review-C8 carry): a stale profile through a town drive stays widened and is never saved', () => {
  // 15 min in town: 25 km/h with a 10°/s turn for 4 s of every 20 s, a 20 s stop every 90 s, mirror checks, and a
  // 7.5 s lap-phone look every 60 s (the city D1 buffer is 6 s). The profile's centres (gaze and head) moved.
  const town = (): DriverFn =>
    attentive((t) => {
      const stop = t % 90 >= 70;
      const phone = t % 60 >= 30 && t % 60 < 37.5;
      return { speedKmh: stop ? 0 : 25, turnDegS: !stop && t % 20 < 4 ? 10 : 0, ...(phone ? { gaze: rel(0, -35) } : {}) };
    });
  const shifted = (dy: number, dp: number): DmsProfileV1 => {
    const g = PROFILE.gazeCentres.geometric!;
    return { ...PROFILE, gazeCentres: { geometric: { yaw: g.yaw + dy, pitch: g.pitch + dp } }, headCentre: { yaw: PROFILE.headCentre.yaw + dy, pitch: PROFILE.headCentre.pitch + dp } };
  };
  const inPhone = (tMs: number) => tMs % 60_000 >= 30_000 && tMs % 60_000 < 40_000;
  const phoneD1 = (d: Drive) => d1(d).filter((c) => inPhone(c.tMs)).length;
  const falseD1 = (d: Drive) => d1(d).filter((c) => !inPhone(c.tMs)).length;
  let ref = 0;
  beforeAll(() => {
    ref = phoneD1(drive(town(), 900, { seed: 34, profile: PROFILE }));
  });
  // Measured (seed 34, 15 looks): the correct profile 15, 8° right 15, 8° up 15, 8° down 12. The downward offset is the
  // review's lap-direction residual (a stale seed below the road puts part of the lap look in the cluster band, a
  // driving zone, even widened); it is recorded at its measured value, 3 looks fewer.
  test.each([
    ['8° right', 8, 0, 0],
    ['8° up', 0, 8, 0],
    ['8° down (the lap-direction residual: 3 fewer)', 0, -8, 3],
  ] as const)("%s: widened with seed_check, phone D1 as the correct profile's, 0 false D1, not saved", (_, dy, dp, fewer) => {
    const d = drive(town(), 900, { seed: 34, profile: shifted(dy, dp) });
    expect(ref).toBeGreaterThanOrEqual(8);
    expect(phoneD1(d)).toBeGreaterThanOrEqual(ref - fewer);
    expect(falseD1(d)).toBe(0);
    expect(ev(d, 'seed_verified')).toEqual([]);
    expect(at(d, 600_000).calReason).toBe('seed_check');
    expect(d.profile).toBeNull();
  });
});

describe('C7 round 4 (review-C7 Round 4 ruling, B): a legacy profile (the inflated P90) is lowered once, by at most 8 %', () => {
  test('a saved profile is marked earNoiseCorrected', () => {
    expect(PROFILE.earNoiseCorrected).toBe(true);
  });
  test.each([
    [1.05, 0.3],
    [1.15, 0.92 * 1.15 * 0.3],
  ])('a legacy profile %f × the true EAR: the first pass takes the reference to %f (±1.5 %%)', (inflate, want) => {
    const { earNoiseCorrected: _, ...rest } = PROFILE;
    const legacy: DmsProfileV1 = { ...rest, openEyeEar: [0.3 * inflate, 0.3 * inflate] };
    const d = drive(attentive(), 120, { seed: 40, profile: legacy });
    const pass = ev(d, 'calibrated');
    expect(pass).toHaveLength(1);
    expect(Math.abs(at(d, pass[0]!.tMs + 1000).earRef! / want - 1)).toBeLessThanOrEqual(0.015);
  });
});

// ---------------------------------------------------------------------------------------------------------
// C8 round 2 (review-C8 Round 1, R1-P): a Stage 1 pass that disagrees with a VERIFIED seed does not replace it; it
// opens a dispute (the verification windows against the pass centre): two agreeing windows follow a real move
// through the dual state, a window agreeing with the seed discards the pass.
// ---------------------------------------------------------------------------------------------------------

describe('S-WARM-NAV (review-C8 R1-P; NC-C8-P): a navigation start does not overwrite a verified profile', () => {
  const cases: [number, number][] = [];
  for (const readS of [30, 40]) for (let seed = 30; seed <= 37; seed++) cases.push([readS, seed]);
  test.each(cases)('%i s at the navigation screen (14°, −8°), seed %i: ≤ 1.5° from the truth at 120 s and 239 s', (readS, seed) => {
    const d = drive(attentive((t) => (t < readS && t % 10 < 8.5 ? { gaze: rel(14, -8) } : null)), 240, { seed, profile: PROFILE });
    const truth = PROFILE.gazeCentres.geometric!;
    expect(angularDistanceDeg(at(d, 120_000).centre!, truth)).toBeLessThanOrEqual(1.5);
    expect(angularDistanceDeg(at(d, 239_000).centre!, truth)).toBeLessThanOrEqual(1.5);
  });
});

describe('S-VERIFIED-THEN-MOVE (review-C8 R1-P): a verified profile, then a real 8° posture shift, is followed', () => {
  test('the seat moved at 70 s (8° right, the box and the IOD with it): the centre follows within 120 s, ≤ 1.5°', () => {
    const shift = { yaw: 8, pitch: 0 };
    const d = drive(attentive((t) => (t >= 70 ? { posture: { shift, box: { dx: 0.055, dy: 0 }, iodScale: 1.07 } } : null)), 260, { seed: 41, profile: PROFILE });
    expect(ev(d, 'seed_verified')).toHaveLength(1);
    expect(ev(d, 'seed_verified')[0]!.tMs).toBeLessThan(70_000);
    const g = PROFILE.gazeCentres.geometric!;
    const want = { yaw: g.yaw + shift.yaw, pitch: g.pitch + shift.pitch };
    expect(angularDistanceDeg(at(d, 190_000).centre!, want)).toBeLessThanOrEqual(1.5);
    expect(angularDistanceDeg(at(d, 259_000).centre!, want)).toBeLessThanOrEqual(1.5);
  });
});

describe('C8 round 2 (review-C8 minor): a verified C2 seed ends the warm start retries', () => {
  // The driver starts leaning (the face box and IOD moved: the profile's mount signature fails), the host takes a C2
  // seed at 3 s from that posture, which verifies (11 s); at 40 s the driver sits back as in the profile, which would
  // match (a camera_bump and a dual state follow, committed at 109 s, then probation). The outcome is pinned; the rule
  // itself is not isolated here (the deferral and the retry cap also keep the profile out in this drive).
  test('a C2 seed at 3 s in a leaning posture, verified; the driver sits back at 40 s: the profile is not adopted after the verification', () => {
    const lean = { shift: { yaw: 8, pitch: -4 }, box: { dx: 0.1, dy: 0.05 }, iodScale: 1.15 };
    const items = synthDrive({ fps: 15, seconds: 150, seed: 42, source: 'geometric', driver: attentive((t) => (t < 40 ? { posture: lean } : null)), motion: true, faceGeometry: true });
    const e = createDmsEngine(C, { ...DEFAULT_INIT, profile: PROFILE });
    const events: string[] = [];
    let seeded = false;
    for (const it of items) {
      if (it.row !== undefined) e.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      e.pushFrame(it.frame);
      if (!seeded && it.frame.tMs >= 3000) {
        seeded = e.seedFromSetup().ok;
      }
      events.push(...e.drain().events.map((x) => `${Math.round(x.tMs / 1000)}:${x.kind}`));
    }
    expect(seeded).toBe(true);
    const verified = events.filter((x) => x.endsWith(':seed_verified'));
    expect(verified.length).toBeGreaterThanOrEqual(1);
    const vT = Number(verified[0]!.split(':')[0]);
    expect(events.filter((x) => x.endsWith(':warm_start') && Number(x.split(':')[0]) > vT)).toEqual([]);
  });
});
