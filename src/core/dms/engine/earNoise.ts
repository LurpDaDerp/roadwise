// C7 round 4 (review-C7 Round 4 ruling, B): the noise-corrected open-eye reference.
//
// The open-eye EAR reference is the P90 of open frames (it stays in the upper part of the open distribution, above
// the lowered-lid frames). With per-frame EAR noise the P90 is inflated by about 1.28σ of that noise, which lowers
// every openness and puts a reading lid nearer the deep threshold. The deconvolved P90 removes the per-frame noise
// only: with v90 the window's P90, m its median, σ_t = (v90 − m) ÷ 1.2816 and σ_n the frame-to-frame noise,
//   ref = m + (v90 − m) × √max(0, 1 − (σ_n/σ_t)²)   (ref = m when σ_t ≤ 0).
// σ_n = 1.4826 × median(|EAR_i − EAR_{i−1}|) ÷ √2 over consecutive TRACKING frame pairs, both open (≥ 0.7 of the
// current reference), no more than 1.5 frame intervals apart; capped at `baselines.earNoiseMaxSd` (0.012 EAR; K12
// measures the real value). The Δ statistics live in bounded histograms: O(1) memory, no allocation per frame.
import { quantile } from './stats';

/** The deconvolved P90 from a window's P90 and median, for a per-frame noise σ_n (null: no correction). */
export function deconvolvedP90(v90: number, m: number, sigmaN: number | null): number {
  if (sigmaN === null || !(sigmaN > 0)) return v90;
  const spread = v90 - m;
  if (!(spread > 0)) return m;
  const st = spread / 1.2816;
  const r = sigmaN / st;
  return m + spread * Math.sqrt(Math.max(0, 1 - r * r));
}

/** The corrected reference of a window of open-eye EARs (the P90 when no noise estimate exists); null when empty. */
export function correctedRef(xs: readonly number[], sigmaN: number | null): number | null {
  if (xs.length === 0) return null;
  return deconvolvedP90(quantile(xs as number[], 0.9), quantile(xs as number[], 0.5), sigmaN);
}

/** σ_n from a series of (time, EAR) frames (the C2 seed's window: no meter exists yet), capped; null with too few pairs. */
export function noiseOfSeries(ts: readonly number[], ears: readonly number[], cap: number): number | null {
  if (ears.length < 3) return null;
  const m = quantile(ears as number[], 0.5);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
  const g = quantile(gaps, 0.5);
  const ds: number[] = [];
  for (let i = 1; i < ears.length; i++) {
    if (ts[i]! - ts[i - 1]! > 1.5 * g + 1e-9) continue;
    if (ears[i]! < 0.7 * m || ears[i - 1]! < 0.7 * m) continue;
    ds.push(Math.abs(ears[i]! - ears[i - 1]!));
  }
  if (ds.length < MIN_PAIRS) return null;
  return Math.min(cap, (1.4826 * quantile(ds, 0.5)) / Math.SQRT2);
}

const MIN_PAIRS = 20;
const D_BINS = 240;
const D_BIN = 0.00025;
const E_BINS = 150;
const E_BIN = 0.004;
const BUCKETS = 5;

/** Per eye: the |ΔEAR| of consecutive open frame pairs and the recent EARs, in 5 one-minute buckets. */
export class EarNoiseMeter {
  private readonly d = { r: new Float64Array(BUCKETS * D_BINS), l: new Float64Array(BUCKETS * D_BINS) };
  private readonly e = { r: new Float64Array(BUCKETS * E_BINS), l: new Float64Array(BUCKETS * E_BINS) };
  private readonly minute = { r: new Array<number>(BUCKETS).fill(Number.NEGATIVE_INFINITY), l: new Array<number>(BUCKETS).fill(Number.NEGATIVE_INFINITY) };
  private readonly prev: { r: { t: number; ear: number } | null; l: { t: number; ear: number } | null } = { r: null, l: null };
  /** the typical frame interval, ms (an EMA of the consecutive intervals) */
  private interval: number | null = null;
  private lastT: number | null = null;

  constructor(private readonly cap: number) {}

  private slot(side: 'r' | 'l', tMs: number): number {
    const m = Math.floor(tMs / 60_000);
    const i = ((m % BUCKETS) + BUCKETS) % BUCKETS;
    if (this.minute[side][i] !== m) {
      this.d[side].fill(0, i * D_BINS, (i + 1) * D_BINS);
      this.e[side].fill(0, i * E_BINS, (i + 1) * E_BINS);
      this.minute[side][i] = m;
    }
    return i;
  }

  /** A TRACKING frame (once per frame, before the eyes). */
  frame(tMs: number): void {
    if (this.lastT !== null) {
      const dt = tMs - this.lastT;
      if (dt > 0) this.interval = this.interval === null ? dt : this.interval + 0.05 * (dt - this.interval);
    }
    this.lastT = tMs;
  }

  /** A frame's EAR for one eye (null: the eye not usable, which breaks the pair chain). `ref` is the current reference. */
  eye(side: 'r' | 'l', tMs: number, ear: number | null, ref: number | null): void {
    if (ear === null) {
      this.prev[side] = null;
      return;
    }
    const i = this.slot(side, tMs);
    const eb = Math.min(E_BINS - 1, Math.max(0, Math.floor(ear / E_BIN)));
    this.e[side][i * E_BINS + eb]! += 1;
    const open = (ref ?? this.median(side, tMs)) * 0.7;
    const pv = this.prev[side];
    if (pv !== null && this.interval !== null && tMs - pv.t <= 1.5 * this.interval + 1e-6 && ear >= open && pv.ear >= open) {
      const db = Math.min(D_BINS - 1, Math.floor(Math.abs(ear - pv.ear) / D_BIN));
      this.d[side][i * D_BINS + db]! += 1;
    }
    this.prev[side] = { t: tMs, ear };
  }

  /** A gap (a pause, LOST): no pair spans it. */
  gap(): void {
    this.prev.r = null;
    this.prev.l = null;
    this.lastT = null;
  }

  private median(side: 'r' | 'l', tMs: number): number {
    const v = this.q(this.e[side], E_BINS, side, tMs, 0.5);
    return v === null ? 0 : (v + 0.5) * E_BIN;
  }

  private q(h: Float64Array, bins: number, side: 'r' | 'l', tMs: number, q: number, minN = 1): number | null {
    const m = Math.floor(tMs / 60_000);
    let total = 0;
    for (let i = 0; i < BUCKETS; i++) {
      if (!(this.minute[side][i]! > m - BUCKETS)) continue;
      for (let j = 0; j < bins; j++) total += h[i * bins + j]!;
    }
    if (total < minN || !(total > 0)) return null;
    let run = 0;
    for (let j = 0; j < bins; j++) {
      for (let i = 0; i < BUCKETS; i++) if (this.minute[side][i]! > m - BUCKETS) run += h[i * bins + j]!;
      if (run >= q * total - 1e-12) return j;
    }
    return bins - 1;
  }

  /** σ_n for one eye over the last 5 minutes, capped; null with fewer than MIN_PAIRS pairs. */
  sigma(side: 'r' | 'l', tMs: number): number | null {
    const j = this.q(this.d[side], D_BINS, side, tMs, 0.5, MIN_PAIRS);
    if (j === null) return null;
    return Math.min(this.cap, (1.4826 * (j + 0.5) * D_BIN) / Math.SQRT2);
  }

  reset(): void {
    this.d.r.fill(0);
    this.d.l.fill(0);
    this.e.r.fill(0);
    this.e.l.fill(0);
    this.minute.r.fill(Number.NEGATIVE_INFINITY);
    this.minute.l.fill(Number.NEGATIVE_INFINITY);
    this.gap();
    this.interval = null;
  }
}
