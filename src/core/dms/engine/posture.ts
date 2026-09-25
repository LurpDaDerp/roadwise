// The posture detector and the relative statistics (Task C4; design rev2 §2.3.0, §2.3.2; rev1 K1; rev4 §2.3.2a).
// Pure helpers of the calibrator; bounded windows only.
//
// - The signal is the TRANSLATION of the face, never a head-angle step alone (K1): the face box with the part
//   a head rotation explains removed, `boxC = box − B·[yaw, pitch]` (a per-drive ridge fit toward the prior
//   boxPerDegPrior, over running sums that decay with fitDecayS; C4 round 1), and the projected IOD,
//   `iodC = iod / (cos yaw · cos pitch)`. A box shift that the fit's remaining uncertainty could explain from the
//   step's head change is no evidence (fitUncertainty; C4 round 1).
// - A settled step: every 500 ms, the medians of the two halves of the last 2 × halfWindowS differ by
//   |ΔboxC| ≥ boxShiftC or |ΔiodC| ≥ iodFracC; the window's first and last spanS sit at the old and the new level
//   (within 20 % of the step), and the transition (the time between 20 % and 80 % of the step) took ≤ spanS.
// - A settled head-pitch drop of slumpPitchDeg or more with no translation is a slump CANDIDATE: the calibrator
//   emits head_slump only once it has held slumpHoldS with the gaze on the road (C4 round 1, C4-3); never posture.
// - The onset: half the threshold reached within 2 s and held 1 s; the calibrator widens the zones meanwhile.
// - The detector is fed TRACKING frames while moving only: a stop is a gap (clear()), and the calibrator
//   compares the settled windows on both sides of it instead (rev4 §2.3.2a).
import { angularDistanceDeg } from './angles';
import type { DmsConfig } from './config';
import { histogramMode, refineMode, type WeightedDir } from './histogram';
import { median } from './stats';
import type { AnglePair } from './types';
import { RingBuffer } from './windows';

/** One TRACKING frame: the head pose (camera frame, degrees), the face box centre and the IOD. */
export interface PostureSample {
  t: number;
  yaw: number;
  pitch: number;
  cx: number;
  cy: number;
  iod: number;
}

export interface PostureStep {
  t: number;
  /** the compensated box shift (image fraction) */
  dBox: { x: number; y: number };
  /** the compensated IOD change, as a fraction of the old */
  dIodFrac: number;
  /** the head-angle change across the step (camera frame, degrees) */
  dHead: AnglePair;
}

export interface PostureOut {
  step: PostureStep | null;
  /** a slump CANDIDATE (C4 round 1): the calibrator watches it for slumpHoldS before any head_slump */
  slump: boolean;
  onset: boolean;
  /** with `slump`: the head pitch and yaw before the drop (camera frame, degrees) */
  slumpFrom?: { pitch: number; yaw: number };
}

/** The compensated signature of a set of frames (the across-stop comparison). */
export interface CompSignature {
  cx: number;
  cy: number;
  iodC: number;
  yaw: number;
  pitch: number;
}

interface Comp {
  t: number;
  cx: number;
  cy: number;
  iodC: number;
  yaw: number;
  pitch: number;
}

const MAX_FPS = 30;
const RAD = Math.PI / 180;
const CHECK_EVERY_MS = 500;
const ONSET_WITHIN_MS = 2000;
const ONSET_HOLD_MS = 1000;
/** C4 round 1 (review-C4 minors): the returned literals are hoisted (no allocation per frame) */
const NONE: PostureOut = Object.freeze({ step: null, slump: false, onset: false });
const ONSET: PostureOut = Object.freeze({ step: null, slump: false, onset: true });

export interface PostureDetector {
  push(s: PostureSample): PostureOut;
  /** A gap (a stop, a pause): the window is forgotten, the fit is kept. */
  clear(): void;
  /** The geometry changed (a bump, a step): the fit's sums restart from the next frame (the last fit is kept meanwhile). */
  resetFit(): void;
  compensate(s: PostureSample): { cx: number; cy: number; iodC: number };
  signature(samples: readonly PostureSample[]): CompSignature | null;
}

export function createPostureDetector(cfg: Pick<DmsConfig, 'calibration'>): PostureDetector {
  const po = cfg.calibration.posture;
  const half = po.halfWindowS * 1000;
  /** the raw samples: compensated at each check with the current fit, so a refit never makes a step */
  const raw = new RingBuffer<PostureSample>(Math.ceil(2 * po.halfWindowS * MAX_FPS) + 2);
  let nextCheck = Number.NEGATIVE_INFINITY;
  let onsetFlag = false;
  // The fit: running sums of yaw, pitch and the box centre.
  const sum = { n: 0, y: 0, p: 0, yy: 0, pp: 0, yp: 0, x: 0, v: 0, yx: 0, px: 0, yv: 0, pv: 0 };
  /**
   * The box-on-head relation: a ridge fit toward the prior (the box centre moves boxPerDegPrior per degree of head
   * yaw toward image right and of pitch up; K-item D-C4-1), over sums that decay with fitDecayS. C4 round 1
   * (review-C4 C4-2): an axis the head's variance supports (≫ fitRidgeDeg2) is learned, the others stay near the
   * prior, so an eyes-only driver keeps the prior and a mirror-checking one learns the yaw column.
   */
  const prior = { xy: po.boxPerDegPrior, xp: 0, vy: 0, vp: -po.boxPerDegPrior };
  let B = { ...prior };
  let nextFit = Number.NEGATIVE_INFINITY;
  let lastT: number | null = null;
  /** each axis's unlearned share of the ridge estimate, λ / (variance + λ): 1 before any data */
  let unlearned = { yaw: 1, pitch: 1 };

  /** The fit learns from every frame; the sums decay with fitDecayS (C4 round 1). */
  function learn(s: PostureSample): void {
    const decay = lastT === null ? 1 : Math.exp(-Math.max(0, s.t - lastT) / (po.fitDecayS * 1000));
    lastT = s.t;
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] *= decay;
    sum.n++;
    sum.y += s.yaw;
    sum.p += s.pitch;
    sum.yy += s.yaw * s.yaw;
    sum.pp += s.pitch * s.pitch;
    sum.yp += s.yaw * s.pitch;
    sum.x += s.cx;
    sum.v += s.cy;
    sum.yx += s.yaw * s.cx;
    sum.px += s.pitch * s.cx;
    sum.yv += s.yaw * s.cy;
    sum.pv += s.pitch * s.cy;
  }

  function refit(t: number): void {
    nextFit = t + CHECK_EVERY_MS;
    const n = sum.n;
    if (n < po.fitMinSamples) return; // too little yet: the prior
    const my = sum.y / n;
    const mp = sum.p / n;
    const lam = po.fitRidgeDeg2;
    unlearned = { yaw: lam / Math.max(lam, sum.yy / n - my * my + lam), pitch: lam / Math.max(lam, sum.pp / n - mp * mp + lam) };
    const syy = sum.yy / n - my * my + lam;
    const spp = sum.pp / n - mp * mp + lam;
    const syp = sum.yp / n - my * mp;
    const det = syy * spp - syp * syp;
    const mx = sum.x / n;
    const mv = sum.v / n;
    // (S + λI)⁻¹ (s + λ·B_prior), per box axis.
    const syx = sum.yx / n - my * mx + lam * prior.xy;
    const spx = sum.px / n - mp * mx + lam * prior.xp;
    const syv = sum.yv / n - my * mv + lam * prior.vy;
    const spv = sum.pv / n - mp * mv + lam * prior.vp;
    const clamp = (b: number) => Math.max(-0.02, Math.min(0.02, b));
    B = {
      xy: clamp((spp * syx - syp * spx) / det),
      xp: clamp((syy * spx - syp * syx) / det),
      vy: clamp((spp * syv - syp * spv) / det),
      vp: clamp((syy * spv - syp * syv) / det),
    };
  }

  function compensate(s: PostureSample): { cx: number; cy: number; iodC: number } {
    const cos = Math.max(0.3, Math.cos(s.yaw * RAD) * Math.cos(s.pitch * RAD));
    return { cx: s.cx - (B.xy * s.yaw + B.xp * s.pitch), cy: s.cy - (B.vy * s.yaw + B.vp * s.pitch), iodC: s.iod / cos };
  }

  function levels(xs: readonly Comp[]) {
    return { cx: median(xs.map((x) => x.cx)), cy: median(xs.map((x) => x.cy)), iodC: median(xs.map((x) => x.iodC)), yaw: median(xs.map((x) => x.yaw)), pitch: median(xs.map((x) => x.pitch)) };
  }

  /** The window's normalised series of the step (0 at the old level, 1 at the new). */
  function series(xs: readonly Comp[], kind: 'box' | 'iod' | 'pitch', a: ReturnType<typeof levels>, b: ReturnType<typeof levels>): number[] {
    if (kind === 'iod') return xs.map((x) => (x.iodC - a.iodC) / (b.iodC - a.iodC));
    if (kind === 'pitch') return xs.map((x) => (x.pitch - a.pitch) / (b.pitch - a.pitch));
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const d2 = dx * dx + dy * dy;
    return xs.map((x) => ((x.cx - a.cx) * dx + (x.cy - a.cy) * dy) / d2);
  }

  /**
   * Settled (both ends at their levels, and the new level already reached in the first second after the cut,
   * so the step is whole and measured in full) and quick (the 20–80 % transition within spanS).
   */
  function settledAndQuick(xs: readonly Comp[], norm: readonly number[], tNow: number): boolean {
    const span = po.spanS * 1000;
    const t0 = xs[0]!.t;
    const cut = tNow - half;
    const head = norm.filter((_, i) => xs[i]!.t < t0 + span);
    const tail = norm.filter((_, i) => xs[i]!.t >= tNow - span);
    const early = norm.filter((_, i) => xs[i]!.t >= cut && xs[i]!.t < cut + 1000);
    if (head.length === 0 || tail.length === 0 || early.length === 0) return false;
    if (Math.abs(median(head)) > 0.2 || Math.abs(median(tail) - 1) > 0.2 || median(early) < 0.8) return false;
    const sm = norm.map((_, i) => median(norm.slice(Math.max(0, i - 2), Math.min(norm.length, i + 3))));
    let inBand = 0;
    for (let i = 1; i < xs.length; i++) {
      const a = sm[i - 1]!;
      const b = sm[i]!;
      const dt = xs[i]!.t - xs[i - 1]!.t;
      if (a === b) {
        if (a > 0.2 && a < 0.8) inBand += dt;
        continue;
      }
      const lo = Math.max(Math.min(a, b), 0.2);
      const hi = Math.min(Math.max(a, b), 0.8);
      if (hi > lo) inBand += ((hi - lo) / Math.abs(b - a)) * dt;
    }
    return inBand / 0.6 <= span;
  }

  return {
    compensate,

    resetFit() {
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] = 0;
      nextFit = Number.NEGATIVE_INFINITY;
      B = { ...prior };
      unlearned = { yaw: 1, pitch: 1 };
    },

    clear() {
      raw.clear();
      nextCheck = Number.NEGATIVE_INFINITY;
      onsetFlag = false;
    },

    signature(samples) {
      if (samples.length === 0) return null;
      const cs = samples.map((s) => ({ ...compensate(s), yaw: s.yaw, pitch: s.pitch }));
      return { cx: median(cs.map((c) => c.cx)), cy: median(cs.map((c) => c.cy)), iodC: median(cs.map((c) => c.iodC)), yaw: median(cs.map((c) => c.yaw)), pitch: median(cs.map((c) => c.pitch)) };
    },

    push(s) {
      learn(s);
      if (s.t >= nextFit) refit(s.t);
      raw.push(s);
      raw.dropWhile((x) => x.t < s.t - 2 * half);
      if (s.t < nextCheck) return onsetFlag ? ONSET : NONE;
      nextCheck = s.t + CHECK_EVERY_MS;
      const all: Comp[] = raw.toArray().map((x) => ({ t: x.t, ...compensate(x), yaw: x.yaw, pitch: x.pitch }));
      if (all.length < 8 || all[0]!.t > s.t - 2 * half + 1000) return onsetFlag ? ONSET : NONE;
      const cut = s.t - half;
      const before = all.filter((x) => x.t < cut);
      const after = all.filter((x) => x.t >= cut);
      if (before.length < 4 || after.length < 4) return onsetFlag ? ONSET : NONE;
      const a = levels(before);
      const b = levels(after);
      // C4 round 1 (C4-2): the part of the box shift the fit's remaining uncertainty could explain from the head
      // change is not evidence (a held look with a wrong prior); only a box shift beyond it counts.
      const explained = po.boxPerDegPrior * po.fitUncertainty * Math.hypot(unlearned.yaw * (b.yaw - a.yaw), unlearned.pitch * (b.pitch - a.pitch));
      const dBoxRaw = Math.hypot(b.cx - a.cx, b.cy - a.cy);
      const dBox = dBoxRaw > explained ? dBoxRaw : 0;
      const dIod = a.iodC > 0 ? (b.iodC - a.iodC) / a.iodC : 0;

      // The onset: the last 1 s and the second before it both at half the threshold from the old level.
      if (!onsetFlag) {
        const recent = levels(all.filter((x) => x.t >= s.t - ONSET_HOLD_MS));
        const prior = all.filter((x) => x.t >= s.t - ONSET_WITHIN_MS && x.t < s.t - ONSET_HOLD_MS);
        if (prior.length > 0) {
          const p = levels(prior);
          const past = (l: ReturnType<typeof levels>) => Math.hypot(l.cx - a.cx, l.cy - a.cy) >= po.boxShiftC / 2 || (a.iodC > 0 && Math.abs(l.iodC - a.iodC) / a.iodC >= po.iodFracC / 2);
          if (past(recent) && past(p)) onsetFlag = true;
        }
      }

      const boxRatio = dBox / po.boxShiftC;
      const iodRatio = Math.abs(dIod) / po.iodFracC;
      if (boxRatio >= 1 || iodRatio >= 1) {
        const kind = boxRatio >= iodRatio ? 'box' : 'iod';
        if (!settledAndQuick(all, series(all, kind, a, b), s.t)) return onsetFlag ? ONSET : NONE;
        raw.clear();
        onsetFlag = false;
        return { step: { t: s.t, dBox: { x: b.cx - a.cx, y: b.cy - a.cy }, dIodFrac: dIod, dHead: { yaw: b.yaw - a.yaw, pitch: b.pitch - a.pitch } }, slump: false, onset: false };
      }
      // A slump: the head settles lower with no translation.
      if (b.pitch - a.pitch <= -po.slumpPitchDeg && boxRatio < 0.5 && iodRatio < 0.5 && settledAndQuick(all, series(all, 'pitch', a, b), s.t)) {
        raw.clear();
        onsetFlag = false;
        return { step: null, slump: true, onset: false, slumpFrom: { pitch: a.pitch, yaw: a.yaw } };
      }
      return onsetFlag ? ONSET : NONE;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The relative statistics (rev2 §2.3.0): decisions relative to the measured spread, never absolute shares.
// ---------------------------------------------------------------------------------------------------------

/** The weight share of `dirs` within `r` degrees of `x`. */
export function shareNear(dirs: readonly WeightedDir[], x: AnglePair, r: number): number {
  let total = 0;
  let near = 0;
  for (const d of dirs) {
    if (!(d.w > 0)) continue;
    total += d.w;
    if (angularDistanceDeg(d, x) <= r) near += d.w;
  }
  return total > 0 ? near / total : 0;
}

/** The ring the vacated and revert tests measure in: max(1.5°, min(radius/2, d/2)). */
export function vacatedRing(c0: AnglePair, c1: AnglePair, radius: number): number {
  return Math.max(1.5, Math.min(radius / 2, angularDistanceDeg(c0, c1) / 2));
}

/** c₀ is vacated: S(c₀, r_v) < vacatedRatio · S(c₁, r_v). */
export function relativelyVacated(dirs: readonly WeightedDir[], c0: AnglePair, c1: AnglePair, radius: number, cfg: Pick<DmsConfig, 'calibration'>): boolean {
  const r = vacatedRing(c0, c1, radius);
  return shareNear(dirs, c0, r) < cfg.calibration.posture.vacatedRatio * shareNear(dirs, c1, r);
}

/**
 * C5 round 1 (the rule), C7 round 1 (shared with health): c₀ is vacated BEYOND NOISE. The share near c₀ above what
 * c₁'s own spread puts there (a Gaussian at σ̂: exp(−d²/2σ̂²) of c₁'s share) is at most `excessMax` of c₁'s. A shifted
 * road leaves c₀ to the noise; a display watched 70 % of the time leaves the road watched 30 %, an excess of about 0.4.
 */
export function vacatedBeyondNoise(dirs: readonly WeightedDir[], c0: AnglePair, c1: AnglePair, radius: number, sigma: number, excessMax: number): boolean {
  const rv = vacatedRing(c0, c1, radius);
  const s1 = shareNear(dirs, c1, rv);
  if (!(s1 > 0)) return false;
  const d = angularDistanceDeg(c0, c1);
  const expected = s1 * Math.exp(-(d * d) / (2 * sigma * sigma));
  return (shareNear(dirs, c0, rv) - expected) / s1 <= excessMax;
}

/** The samples are back at c₀: S(c₀, r_v) ≥ S(c₁, r_v). */
export function relativeRevert(dirs: readonly WeightedDir[], c0: AnglePair, c1: AnglePair, radius: number, _cfg: Pick<DmsConfig, 'calibration'>): boolean {
  const r = vacatedRing(c0, c1, radius);
  return shareNear(dirs, c0, r) >= shareNear(dirs, c1, r);
}

/**
 * Unimodal around `mode`: no second peak (a local maximum of 3 × 3 sums of 2° cells) within radius + 10°,
 * beyond 2σ̂ of the mode, holding unimodalRatio of the main one's weight.
 */
export function unimodal(dirs: readonly WeightedDir[], mode: AnglePair, radius: number, sigma: number, cfg: Pick<DmsConfig, 'calibration'>): boolean {
  const cell = 2;
  const reach = radius + 10;
  const n = Math.ceil(reach / cell);
  const size = 2 * n + 1;
  const grid = new Float64Array(size * size);
  for (const d of dirs) {
    if (!(d.w > 0)) continue;
    const i = Math.round((d.yaw - mode.yaw) / cell) + n;
    const j = Math.round((d.pitch - mode.pitch) / cell) + n;
    if (i < 0 || j < 0 || i >= size || j >= size) continue;
    grid[i * size + j] = grid[i * size + j]! + d.w;
  }
  const at = (i: number, j: number) => {
    let s = 0;
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) if (a >= 0 && b >= 0 && a < size && b < size) s += grid[a * size + b]!;
    return s;
  };
  const main = at(n, n);
  if (!(main > 0)) return false;
  const exclude = 2 * sigma;
  // A second peak: a local maximum of the block sums (above all 8 neighbours), beyond 2σ̂ of the mode, holding
  // unimodalRatio of the main block. One cluster, however broad, has no second local maximum.
  for (let i = 1; i < size - 1; i++) {
    for (let j = 1; j < size - 1; j++) {
      const dist = Math.hypot((i - n) * cell, (j - n) * cell);
      if (dist <= exclude || dist > reach) continue;
      const v = at(i, j);
      if (v < cfg.calibration.posture.unimodalRatio * main) continue;
      let peak = true;
      for (let a = -1; a <= 1 && peak; a++) for (let b = -1; b <= 1; b++) if ((a !== 0 || b !== 0) && at(i + a, j + b) > v) { peak = false; break; }
      if (peak) return false;
    }
  }
  return true;
}

/** The mode of a set of directions (the Stage 1 histogram), or null. */
export function modeOf(dirs: readonly WeightedDir[], cfg: Pick<DmsConfig, 'calibration'>): AnglePair | null {
  const peak = histogramMode(dirs, cfg);
  return peak === null ? null : refineMode(dirs, peak, cfg);
}

const LOCATE_MAX_IT = 20;
const LOCATE_TOL_DEG = 0.01;
/**
 * Task C5: the centre of the cluster at `start`, located to convergence (a flat-kernel mean shift of radius
 * `radius`, at most LOCATE_MAX_IT steps, until it moves < LOCATE_TOL_DEG). modeOf's refinement (3 steps of
 * 1.5 × sigmaDeg = 3°) stops short at σ 4° and keeps about 40 % of its start error: a steady drift then reads
 * about half its size, so the rolling path engages late.
 */
export function locate(dirs: readonly WeightedDir[], start: AnglePair, radius: number): AnglePair {
  let m = start;
  for (let it = 0; it < LOCATE_MAX_IT; it++) {
    let w = 0;
    let y = 0;
    let p = 0;
    for (const d of dirs) {
      if (!(d.w > 0) || Math.hypot(d.yaw - m.yaw, d.pitch - m.pitch) > radius) continue;
      w += d.w;
      y += d.w * d.yaw;
      p += d.w * d.pitch;
    }
    if (!(w > 0)) break;
    const next = { yaw: y / w, pitch: p / w };
    const moved = Math.hypot(next.yaw - m.yaw, next.pitch - m.pitch);
    m = next;
    if (moved < LOCATE_TOL_DEG) break;
  }
  return m;
}

/**
 * Peaked (rev2 §2.2): among the weight within confidenceWithinDeg of the mode, the share within
 * ρ = max(4°, 1.3σ̂) is at least peakedRatio × a single cluster's at σ̂ (1 − exp(−ρ²/2σ̂²)).
 */
export function peaked(dirs: readonly WeightedDir[], mode: AnglePair, sigma: number, cfg: Pick<DmsConfig, 'calibration'>): boolean {
  const c = cfg.calibration;
  const rho = Math.max(4, 1.3 * sigma);
  const inner = dirs.filter((d) => angularDistanceDeg(d, mode) <= c.confidenceWithinDeg);
  if (inner.length === 0) return false;
  const single = 1 - Math.exp(-(rho * rho) / (2 * sigma * sigma));
  return shareNear(inner, mode, rho) >= c.posture.peakedRatio * single;
}
