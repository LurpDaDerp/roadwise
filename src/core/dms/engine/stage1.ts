// Task C9 (T9; review-C9 "Stage 1 robustness", S1-1): the two-cluster road choice. A display watched more than the
// road is the histogram's mode; a display within about 12° of the road passes the one-mode 15° test with the road
// inside it. The window's two highest histogram peaks ≥ 2ρ apart are looked at; when the second is a cluster (≥
// clusterMinShare of the window within ρ, locally peaked), the road is chosen by what we know of the car:
//   (a) a cluster at the camera (the phone screen) is not the road when the other is farther from the camera;
//   (b) a cluster in a default mirror rectangle, taken relative to the other, is not the road;
//   (c) otherwise the higher one (displays sit below the windscreen line), when the pitches differ by ≥ pitchMinDeg;
//   (d) otherwise the mirror-check returns: ≥ returnMinN of them, ≥ returnShare nearer one cluster; else wait.
// With one cluster, nothing changes, except that a single cluster at an off-road camera (the head's forward
// ≥ radiusMinDeg from the camera) is the phone screen, never the road: no pass. Pure.
import { angularDistanceDeg, relative } from './angles';
import type { DmsConfig } from './config';
import { histogramPeaks, refineMode, type WeightedDir } from './histogram';
import { peakedLocal, shareNear } from './posture';
import type { AnglePair } from './types';

export type RoadRule = 'single' | 'camera' | 'mirror' | 'pitch' | 'returns';

export interface RoadChoice {
  /** the road cluster's centre (the refined peak) */
  road: AnglePair;
  /** the other cluster's, or null with one cluster */
  other: AnglePair | null;
  rule: RoadRule;
  /**
   * C9 round 1 (C9-1): every cluster that is not the road (the other, and any mirror dropped before the choice).
   * Their cores leave the confidence's denominator. Absent: the other alone.
   */
  excluded?: readonly AnglePair[];
}

/** C9 round 1 (C9-1): at most this many clusters are looked at (a display, a frequent mirror and the road). */
export const MAX_CLUSTERS = 3;

export interface RoadOpts {
  /** σ̂ per frame (the local peakedness, T9-1) */
  sigma: number;
  /** the detection scale ρ: the separation (2ρ) and the cluster's share within ρ (default ρ(σ̂)) */
  rho?: number;
  /** the histogram kernel σ for the peak search (default calibration.sigmaDeg) */
  kernelDeg?: number;
  /** the camera's direction (driver frame), or null when unknown */
  camera: AnglePair | null;
  /** the camera is off the road: ≥ radiusMinDeg from the head's forward */
  cameraOffRoad: boolean;
  /** the mirror-check return points in the window (driver frame) */
  returns: readonly AnglePair[];
}

type Cfg = Pick<DmsConfig, 'calibration' | 'zones'>;

/** ρ = max(4°, 1.3σ̂), the cluster scale of T9-1 and S1-1. */
export const clusterRho = (sigma: number): number => Math.max(4, 1.3 * sigma);

const MIRRORS = new Set(['rear_mirror', 'driver_mirror', 'passenger_mirror']);

/** `x` relative to `from` lies in a default (unlearned) mirror rectangle. */
function inMirror(x: AnglePair, from: AnglePair, cfg: Cfg): boolean {
  const rel = relative(x, from);
  for (const z of cfg.zones.table) {
    if (!MIRRORS.has(z.id) || z.region.kind !== 'rect') continue;
    const r = z.region;
    if (rel.yaw >= r.yaw[0] && rel.yaw <= r.yaw[1] && rel.pitch >= r.pitch[0] && rel.pitch <= r.pitch[1]) return true;
  }
  return false;
}

function phoneRadius(cfg: Cfg): number {
  const z = cfg.zones.table.find((x) => x.region.kind === 'camera');
  return z !== undefined && z.region.kind === 'camera' ? z.region.radiusDeg : 0;
}

/**
 * The road cluster of a window, 'wait' when two clusters cannot be told apart yet (or the only cluster is the phone
 * screen), null for an empty window.
 */
export function chooseRoad(dirs: readonly WeightedDir[], o: RoadOpts, cfg: Cfg): RoadChoice | 'wait' | null {
  const tc = cfg.calibration.twoCluster;
  const peaks = histogramPeaks(dirs, o.kernelDeg === undefined ? cfg : { calibration: { ...cfg.calibration, sigmaDeg: o.kernelDeg, kernelHalfBins: Math.ceil(3 * o.kernelDeg) } }, 12);
  if (peaks.length === 0) return null;
  const rho = o.rho ?? clusterRho(o.sigma);
  // C9 round 1 (C9-1): up to MAX_CLUSTERS clusters, the top peak and then each next peak ≥ 2ρ from every one taken
  // that holds clusterMinShare within ρ and is locally peaked on its own side (the frames nearer it than any cluster
  // taken: another cluster's tail is no dispersion of its own).
  const taken: AnglePair[] = [refineMode(dirs, peaks[0]!.at, cfg)];
  const takenAt: AnglePair[] = [peaks[0]!.at];
  for (const pk of peaks.slice(1)) {
    if (taken.length >= MAX_CLUSTERS) break;
    if (takenAt.some((q) => angularDistanceDeg(pk.at, q) < 2 * rho)) continue;
    const m = refineMode(dirs, pk.at, cfg);
    // the refined centres too: a peak on another cluster's flank refines toward it (a display 7° from the road)
    if (taken.some((q) => angularDistanceDeg(m, q) < 2 * rho)) continue;
    const own = dirs.filter((d) => taken.every((t) => angularDistanceDeg(d, m) < angularDistanceDeg(d, t)));
    if (shareNear(dirs, m, rho) >= tc.clusterMinShare && peakedLocal(own, m, o.sigma, cfg.calibration.posture.peakedRatio)) {
      taken.push(m);
      takenAt.push(pk.at);
    }
  }
  // C9 round 1 (C9-1): a cluster inside a default mirror rectangle relative to another cluster that is not itself a
  // mirror is a mirror (rule (b) first, on every pair): dropped before the choice. A frequent mirror then no longer
  // hides the road behind a display.
  const isMirror = taken.map((x, i) => taken.some((q, j) => j !== i && inMirror(x, q, cfg)));
  const dropped: AnglePair[] = [];
  const kept: AnglePair[] = [];
  taken.forEach((x, i) => (taken.some((q, j) => j !== i && !isMirror[j] && inMirror(x, q, cfg)) ? dropped : kept).push(x));
  if (kept.length === 0) kept.push(...dropped.splice(0));
  const camLimit = phoneRadius(cfg) + cfg.calibration.posture.candidateCameraMarginDeg;
  const cam = o.cameraOffRoad ? o.camera : null;
  const a = kept[0]!;
  if (kept.length === 1) {
    if (cam !== null && angularDistanceDeg(a, cam) <= camLimit) return 'wait';
    // a road and its mirror(s): rule (b), as before, with the mirror as the other cluster
    return dropped.length > 0 ? { road: a, other: dropped[0]!, rule: 'mirror', excluded: dropped } : { road: a, other: null, rule: 'single' };
  }
  const b = kept[1]!;
  const rest = [...kept.slice(2), ...dropped];
  const pick = (road: AnglePair, rule: RoadRule): RoadChoice => {
    const other = road === a ? b : a;
    return { road, other, rule, excluded: [other, ...rest] };
  };
  // (a) the camera
  if (cam !== null) {
    const da = angularDistanceDeg(a, cam);
    const db = angularDistanceDeg(b, cam);
    if (da <= camLimit && db > da) return pick(b, 'camera');
    if (db <= camLimit && da > db) return pick(a, 'camera');
  }
  // (b) the mirrors (a pair that are each the other's mirror is left to (c) and (d))
  const bMirror = inMirror(b, a, cfg);
  const aMirror = inMirror(a, b, cfg);
  if (bMirror !== aMirror) return pick(bMirror ? a : b, 'mirror');
  // (c) the higher
  if (Math.abs(a.pitch - b.pitch) >= tc.pitchMinDeg) return pick(a.pitch > b.pitch ? a : b, 'pitch');
  // (d) the returns
  const n = o.returns.length;
  if (n < tc.returnMinN) return 'wait';
  let nearA = 0;
  for (const r of o.returns) if (angularDistanceDeg(r, a) < angularDistanceDeg(r, b)) nearA++;
  if (nearA >= tc.returnShare * n) return pick(a, 'returns');
  if (n - nearA >= tc.returnShare * n) return pick(b, 'returns');
  return 'wait';
}

/**
 * Task C9 (S1-1, deviation): fixation medians. The admitted directions over consecutive blocks of `blockMs` (a block
 * ends at a gap longer than the block; blocks of fewer than 2 frames are dropped), each block's component-wise median,
 * weighted by its time. The geometric path's σ 4° per frame makes an 85 % display and the 15 % road 9° from it ONE
 * mode of the per-frame density (no second local maximum exists); over half a second the frame noise falls (about
 * 1.25σ/√n) and the two fixation targets separate. The median, not the mean: a stray frame or two in a block (a
 * blink, a flick) does not move it. The road choice detects its clusters on these; the pass's statistics stay per frame.
 */
export function fixationMedians(xs: readonly { t: number; a: AnglePair | null; w: number }[], blockMs: number): { dirs: WeightedDir[]; perBlock: number } {
  const out: WeightedDir[] = [];
  const ys: number[] = [];
  const ps: number[] = [];
  let sw = 0;
  let t0 = 0;
  let last = 0;
  let frames = 0;
  const mid = (v: number[]) => {
    v.sort((a, b) => a - b);
    const k = v.length >> 1;
    return v.length % 2 === 1 ? v[k]! : (v[k - 1]! + v[k]!) / 2;
  };
  const close = () => {
    if (ys.length >= 2 && sw > 0) {
      frames += ys.length;
      out.push({ yaw: mid(ys), pitch: mid(ps), w: sw });
    }
    ys.length = 0;
    ps.length = 0;
    sw = 0;
  };
  for (const x of xs) {
    if (x.a === null || !(x.w > 0)) continue;
    if (ys.length > 0 && (x.t - t0 >= blockMs || x.t - last > blockMs)) close();
    if (ys.length === 0) t0 = x.t;
    ys.push(x.a.yaw);
    ps.push(x.a.pitch);
    sw += x.w;
    last = x.t;
  }
  close();
  return { dirs: out, perBlock: out.length > 0 ? frames / out.length : 1 };
}

/** The frames on the road's side: nearer the road than the other cluster (all of them with one cluster). */
export function roadSide(x: AnglePair, ch: RoadChoice): boolean {
  return ch.other === null || angularDistanceDeg(x, ch.road) <= angularDistanceDeg(x, ch.other);
}

/**
 * S1-1's confidence: the weight within `withinDeg` of the road on its side, over the total less the other cluster's
 * weight within ρ of its peak (the H3 exclusion: a display neither delays nor blocks a pass).
 */
export function roadConfidence(dirs: readonly WeightedDir[], ch: RoadChoice, withinDeg: number, rho: number): number {
  const ex = ch.excluded ?? (ch.other !== null ? [ch.other] : []);
  // C9 round 1 (C9-1): each non-road cluster's core reaches max(ρ, min(2ρ, half its distance to the road)): ρ holds
  // only about 57 % of a σ̂ 4° cluster, 2ρ about 95 %, and half the separation keeps the road's own frames out.
  const reach = ex.map((x) => Math.max(rho, Math.min(2 * rho, angularDistanceDeg(x, ch.road) / 2)));
  let total = 0;
  let inside = 0;
  let other = 0;
  for (const d of dirs) {
    if (!(d.w > 0)) continue;
    total += d.w;
    // every non-road cluster's core, each frame once, and never a frame counted for the road (share ≤ 1)
    if (roadSide(d, ch) && angularDistanceDeg(d, ch.road) <= withinDeg) inside += d.w;
    else if (ex.some((x, i) => angularDistanceDeg(d, x) <= reach[i]!)) other += d.w;
  }
  const den = total - other;
  return den > 0 ? inside / den : 0;
}
