// The road-centre estimate (plan §M3; spec Stage 1 steps 3–6): a 2-D histogram of admitted directions
// in the driver frame (1° bins, yaw [−75, 75] × pitch [−50, 50]), Gaussian-smoothed at evaluation
// (σ = 2°, ±6 bins, separable), the peak as the mode (never the mean, which mirror and phone glances
// pull), refined to sub-bin precision by a parabola through the peak and its neighbours, then by a
// local mean shift. Then the
// radius (the weighted p85 of the angular distance of samples within 15° of the mode, clamped to
// [8°, 15°]) and the confidence (the share of weight within 15° of the mode). Pure.
import { angularDistanceDeg } from './angles';
import type { DmsConfig } from './config';
import { weightedQuantile } from './stats';
import type { AnglePair } from './types';

export interface WeightedDir {
  yaw: number;
  pitch: number;
  w: number;
}

export interface ClusterResult {
  mode: AnglePair;
  radius: number;
  /** the share of the total weight within confidenceWithinDeg of the mode */
  share: number;
  total: number;
  passed: boolean;
}

type Cfg = Pick<DmsConfig, 'calibration'>;

function kernel(sigmaBins: number, half: number): Float64Array {
  const k = new Float64Array(2 * half + 1);
  let s = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaBins * sigmaBins));
    k[i + half] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / s;
  return k;
}

/** The smoothed histogram's peak with parabolic refinement; null when nothing falls inside it. */
export function histogramMode(samples: readonly WeightedDir[], cfg: Cfg): AnglePair | null {
  const c = cfg.calibration;
  const [y0, y1] = c.histYawDeg;
  const [p0, p1] = c.histPitchDeg;
  const nY = Math.round((y1 - y0) / c.binDeg);
  const nP = Math.round((p1 - p0) / c.binDeg);
  const h = new Float64Array(nY * nP);
  let any = false;
  for (const s of samples) {
    const i = Math.floor((s.yaw - y0) / c.binDeg);
    const j = Math.floor((s.pitch - p0) / c.binDeg);
    if (i < 0 || i >= nY || j < 0 || j >= nP || !(s.w > 0)) continue;
    h[j * nY + i] = h[j * nY + i]! + s.w;
    any = true;
  }
  if (!any) return null;
  const k = kernel(c.sigmaDeg / c.binDeg, c.kernelHalfBins);
  const half = c.kernelHalfBins;
  const tmp = new Float64Array(nY * nP);
  for (let j = 0; j < nP; j++) {
    for (let i = 0; i < nY; i++) {
      let v = 0;
      for (let d = -half; d <= half; d++) {
        const ii = i + d;
        if (ii >= 0 && ii < nY) v += h[j * nY + ii]! * k[d + half]!;
      }
      tmp[j * nY + i] = v;
    }
  }
  const sm = new Float64Array(nY * nP);
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let j = 0; j < nP; j++) {
    for (let i = 0; i < nY; i++) {
      let v = 0;
      for (let d = -half; d <= half; d++) {
        const jj = j + d;
        if (jj >= 0 && jj < nP) v += tmp[jj * nY + i]! * k[d + half]!;
      }
      sm[j * nY + i] = v;
      if (v > best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  const at = (i: number, j: number) => (i >= 0 && i < nY && j >= 0 && j < nP ? sm[j * nY + i]! : 0);
  const refine = (l: number, m: number, r: number) => {
    const den = l - 2 * m + r;
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
  };
  const di = refine(at(bi - 1, bj), best, at(bi + 1, bj));
  const dj = refine(at(bi, bj - 1), best, at(bi, bj + 1));
  return { yaw: y0 + (bi + 0.5 + di) * c.binDeg, pitch: p0 + (bj + 0.5 + dj) * c.binDeg };
}

/**
 * Refines a peak by mean shift: the weighted mean of the samples within 1.5 σ of the estimate, three
 * times. Local, so still the mode (a far cluster never enters), and exact for a tight cluster that a
 * bin edge would otherwise bias by up to half a bin.
 */
export function refineMode(samples: readonly WeightedDir[], start: AnglePair, cfg: Cfg): AnglePair {
  const r = 1.5 * cfg.calibration.sigmaDeg;
  let m = start;
  for (let it = 0; it < 3; it++) {
    let w = 0;
    let y = 0;
    let p = 0;
    for (const s of samples) {
      if (!(s.w > 0) || Math.hypot(s.yaw - m.yaw, s.pitch - m.pitch) > r) continue;
      w += s.w;
      y += s.w * s.yaw;
      p += s.w * s.pitch;
    }
    if (!(w > 0)) break;
    m = { yaw: y / w, pitch: p / w };
  }
  return m;
}

export function evaluateCluster(samples: readonly WeightedDir[], cfg: Cfg): ClusterResult | null {
  const peak = histogramMode(samples, cfg);
  if (peak === null) return null;
  const mode = refineMode(samples, peak, cfg);
  const c = cfg.calibration;
  let total = 0;
  let inside = 0;
  const d: number[] = [];
  const w: number[] = [];
  for (const s of samples) {
    if (!(s.w > 0)) continue;
    total += s.w;
    const dist = angularDistanceDeg(s, mode);
    if (dist <= c.confidenceWithinDeg) {
      inside += s.w;
      d.push(dist);
      w.push(s.w);
    }
  }
  const raw = d.length > 0 ? weightedQuantile(d, w, c.radiusPercentile) : c.radiusMinDeg;
  const radius = Math.min(c.radiusMaxDeg, Math.max(c.radiusMinDeg, raw));
  const share = total > 0 ? inside / total : 0;
  return { mode, radius, share, total, passed: share >= c.confidenceMinShare };
}
