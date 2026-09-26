// Task C9 (T9; review-C9 T9-2): the gaze template and its translation search. A posture step (a seat move, a bump, a
// resume across a gap) moves every direction the driver looks at by the same angle; a display watched part of the
// time moves with it. So the dual state's candidate is not the window's single peak (which a display near the road
// can flatten or pull) but the translation Δ that best maps the pre-step histogram (the template R) onto the window W:
// s(Δ) = Σ min(W(x), R(x − Δ)), both normalised to 1.
//
// The template is a decayed histogram (τ, 2° cells, driver frame, ±60°) of the admitted directions in calibrated
// non-dual time: O(1) per admitted frame (a lazy global decay), a fixed 60 × 60 grid, no allocation per frame.
import type { AnglePair } from './types';
import type { WeightedDir } from './histogram';

export const CELL = 2;
const HALF = 60;
const N = (2 * HALF) / CELL;

/** A normalised template snapshot (sums to 1) on the fixed grid. */
export interface TemplateSnapshot {
  grid: Float32Array;
  /** the admitted weight behind it (seconds, decayed) */
  weight: number;
}

const cellOf = (v: number) => Math.floor((v + HALF) / CELL);
const centreOf = (i: number) => -HALF + (i + 0.5) * CELL;

/** A decayed direction histogram (τ seconds). */
export class DirTemplate {
  private readonly g = new Float32Array(N * N);
  private total = 0;
  private refT: number | null = null;

  constructor(private readonly tauS: number) {}

  add(a: AnglePair, w: number, tMs: number): void {
    if (!(w > 0)) return;
    if (cellOf(a.yaw) < 0 || cellOf(a.pitch) < 0 || cellOf(a.yaw) >= N || cellOf(a.pitch) >= N) return;
    this.refT ??= tMs;
    let k = Math.exp((tMs - this.refT) / 1000 / this.tauS);
    if (k > 1e6) {
      // re-anchor: scale everything down, so the growing factor stays finite
      for (let x = 0; x < this.g.length; x++) this.g[x] = this.g[x]! / k;
      this.total /= k;
      this.refT = tMs;
      k = 1;
    }
    // bilinear splat over the four nearest cell centres (as the window is built)
    const fi = (a.yaw + HALF) / CELL - 0.5;
    const fj = (a.pitch + HALF) / CELL - 0.5;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const ti = fi - i0;
    const tj = fj - j0;
    for (let di = 0; di < 2; di++) {
      const i = i0 + di;
      const wi = di === 0 ? 1 - ti : ti;
      if (i < 0 || i >= N || !(wi > 0)) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        const wj = dj === 0 ? 1 - tj : tj;
        if (j < 0 || j >= N || !(wj > 0)) continue;
        this.g[i * N + j] = this.g[i * N + j]! + w * k * wi * wj;
      }
    }
    this.total += w * k;
  }

  /** The decayed weight (seconds) as of `tMs`. */
  weight(tMs: number): number {
    if (this.refT === null) return 0;
    return this.total / Math.exp((tMs - this.refT) / 1000 / this.tauS);
  }

  snapshot(tMs: number): TemplateSnapshot | null {
    if (!(this.total > 0)) return null;
    const grid = new Float32Array(N * N);
    for (let x = 0; x < grid.length; x++) grid[x] = this.g[x]! / this.total;
    return { grid, weight: this.weight(tMs) };
  }

  clear(): void {
    this.g.fill(0);
    this.total = 0;
    this.refT = null;
  }
}

/** R at a continuous driver-frame point (bilinear between cell centres; no allocation). */
function sampleAt(R: Float32Array, yaw: number, pitch: number): number {
  const fi = (yaw + HALF) / CELL - 0.5;
  const fj = (pitch + HALF) / CELL - 0.5;
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const ti = fi - i0;
  const tj = fj - j0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= N || j >= N ? 0 : R[i * N + j]!);
  return (1 - ti) * ((1 - tj) * at(i0, j0) + tj * at(i0, j0 + 1)) + ti * ((1 - tj) * at(i0 + 1, j0) + tj * at(i0 + 1, j0 + 1));
}

/**
 * The window as occupied cells (centre, normalised weight). Each direction is splatted bilinearly over its four
 * nearest cell centres (as R is sampled), so a window of a few hundred frames is not a grid of shot noise: the
 * intersection of two histograms of one distribution is then near 1, not held down by empty and doubled cells.
 */
export function windowCells(dirs: readonly WeightedDir[]): { yaw: number; pitch: number; w: number }[] {
  const m = new Map<number, number>();
  let total = 0;
  for (const d of dirs) {
    if (!(d.w > 0)) continue;
    const fi = (d.yaw + HALF) / CELL - 0.5;
    const fj = (d.pitch + HALF) / CELL - 0.5;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const ti = fi - i0;
    const tj = fj - j0;
    for (let di = 0; di < 2; di++) {
      const i = i0 + di;
      const wi = di === 0 ? 1 - ti : ti;
      if (i < 0 || i >= N || !(wi > 0)) continue;
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        const wj = dj === 0 ? 1 - tj : tj;
        if (j < 0 || j >= N || !(wj > 0)) continue;
        m.set(i * N + j, (m.get(i * N + j) ?? 0) + d.w * wi * wj);
      }
    }
    total += d.w;
  }
  const out: { yaw: number; pitch: number; w: number }[] = [];
  if (!(total > 0)) return out;
  m.forEach((w, k) => out.push({ yaw: centreOf(Math.floor(k / N)), pitch: centreOf(k % N), w: w / total }));
  return out;
}

/** s(Δ) = Σ min(W(x), R(x − Δ)). */
export function overlap(W: readonly { yaw: number; pitch: number; w: number }[], R: Float32Array, delta: AnglePair): number {
  let s = 0;
  for (const c of W) s += Math.min(c.w, sampleAt(R, c.yaw - delta.yaw, c.pitch - delta.pitch));
  return s;
}

/**
 * The best translation, coarse to fine: a 2° grid over |Δ| ≤ maxDeg (or within `reach` of `around`), then ±2° at 1°,
 * then ±1° at 0.25° around the best. Returns Δ*, s(Δ*) and s(0).
 */
export function bestShift(W: readonly { yaw: number; pitch: number; w: number }[], R: Float32Array, maxDeg: number, around: AnglePair | null = null, reach = maxDeg): { delta: AnglePair; s: number; s0: number } {
  const s0 = overlap(W, R, { yaw: 0, pitch: 0 });
  let best = { delta: { yaw: 0, pitch: 0 }, s: s0 };
  const c = around ?? { yaw: 0, pitch: 0 };
  const tryAt = (d: AnglePair) => {
    if (Math.hypot(d.yaw, d.pitch) > maxDeg + 1e-9) return;
    const v = overlap(W, R, d);
    if (v > best.s + 1e-12) best = { delta: d, s: v };
  };
  const coarse = reach > 3 ? 2 : 1;
  const r = Math.ceil(reach / coarse);
  for (let dy = -r; dy <= r; dy++) {
    for (let dp = -r; dp <= r; dp++) {
      if (Math.hypot(dy * coarse, dp * coarse) > reach + 1e-9) continue;
      tryAt({ yaw: c.yaw + dy * coarse, pitch: c.pitch + dp * coarse });
    }
  }
  if (coarse > 1) {
    const b1 = best.delta;
    for (let dy = -2; dy <= 2; dy++) for (let dp = -2; dp <= 2; dp++) if (dy !== 0 || dp !== 0) tryAt({ yaw: b1.yaw + dy, pitch: b1.pitch + dp });
  }
  const b0 = best.delta;
  for (let dy = -4; dy <= 4; dy++) for (let dp = -4; dp <= 4; dp++) if (dy !== 0 || dp !== 0) tryAt({ yaw: b0.yaw + dy * 0.25, pitch: b0.pitch + dp * 0.25 });
  return { delta: best.delta, s: best.s, s0 };
}

/**
 * R's share within r of a point: R's density (bilinear between cell centres, mass ÷ cell area) integrated over a 0.5°
 * sub-grid of the disk, so a small ring is not quantised to whole 2° cells.
 */
export function templateShare(R: Float32Array, x: AnglePair, r: number): number {
  const step = 0.5;
  const n = Math.ceil(r / step);
  let s = 0;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const dy = i * step;
      const dp = j * step;
      if (Math.hypot(dy, dp) > r) continue;
      s += sampleAt(R, x.yaw + dy, x.pitch + dp) * ((step * step) / (CELL * CELL));
    }
  }
  return s;
}
