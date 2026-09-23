// MediaPipe landmarks → the `gaze_direct` network's inputs. Only builds with `DMS_GAZE_NET=1` run
// the network (the release gate), but the input assembly is ported on both platforms either way,
// and the golden vectors pin it.
//
// `weak3dCloud`, `eyeCenterAndIod`, `cameraContext`, `landmarkValidity`, `rowStatistics` and
// `SubjectStatisticTracker` are exact ports of the V1 `dms/gaze_inputs.js`, verified against the
// Python reference's own fixtures (`__tests__/fixtures/v1-reference`, synthetic faces).
// `GazeInputAssembler` is new: it states when a frame's statistics enter the tracker, a decision
// V1 took from its drowsiness tracker, which no longer exists natively.
import { DecayingHistogram1D } from './decayingHistogram';
import { LANDMARK_FLOATS, NUM_LANDMARKS, OUTER_CORNERS } from './landmarks';
import { probe } from './probe';

/** `gaze_direct.meta.json` → subject_stats.training_mean. */
export const TRAINING_MEAN = [0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419] as const;
export const STAT_WARMUP_FRAMES = 30;
export const STAT_WINDOW_S = 120.0;
export const STAT_HIST_LO = -0.2;
export const STAT_HIST_HI = 0.2;
export const STAT_HIST_BIN = 0.0025;
/**
 * A frame's statistics enter the tracker only when the mean of the two raw EARs is at least this.
 * It gates ONLY the gaze network's subject statistics (internal builds with DMS_GAZE_NET=1), never a
 * closure rule; the engine's closure thresholds are per-driver and live in DmsConfig. Do not tune it
 * for drowsiness (Task 2 review nit).
 * The statistics describe an open eye, and a blink or a closure would drag the median. This is a
 * fixed, absolute threshold (V1 used its drowsiness tracker's per-driver `eyes_open`).
 */
export const STAT_ADMIT_MIN_EAR = 0.18;

// [[cornerA, cornerB], iris, upper, lower, brow, sign]
const STAT_EYES = [
  [[33, 133], 468, 159, 145, 105, 1.0],
  [[263, 362], 473, 386, 374, 334, -1.0],
] as const;

function norm2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Eye-centred, interocular-normalised weak-3D cloud (`cloud` input), float64. */
export function weak3dCloud(lm: ArrayLike<number>, width: number, height: number): Float64Array {
  const ratio = height / width;
  const r = OUTER_CORNERS[0];
  const l = OUTER_CORNERS[1];
  const cx = 0.5 * (lm[r * 3]! + lm[l * 3]!);
  const cy = 0.5 * (lm[r * 3 + 1]! * ratio + lm[l * 3 + 1]! * ratio);
  const cz = 0.5 * (lm[r * 3 + 2]! + lm[l * 3 + 2]!);
  const out = new Float64Array(LANDMARK_FLOATS);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = lm[i * 3]! - cx;
    out[i * 3 + 1] = lm[i * 3 + 1]! * ratio - cy;
    out[i * 3 + 2] = lm[i * 3 + 2]! - cz;
  }
  const scale = norm2(out[r * 3]! - out[l * 3]!, out[r * 3 + 1]! - out[l * 3 + 1]!);
  if (!Number.isFinite(scale) || scale < 1e-8) throw new Error('degenerate interocular distance');
  for (let i = 0; i < out.length; i++) out[i]! /= scale;
  return out;
}

/** Eye midpoint (frame-width units) and the projected inter-ocular distance. */
export function eyeCenterAndIod(lm: ArrayLike<number>, width: number, height: number): { center: [number, number]; iod: number } {
  const ratio = height / width;
  const r = OUTER_CORNERS[0];
  const l = OUTER_CORNERS[1];
  const rx = lm[r * 3]!;
  const ry = lm[r * 3 + 1]! * ratio;
  const lx = lm[l * 3]!;
  const ly = lm[l * 3 + 1]! * ratio;
  return { center: [0.5 * (rx + lx), 0.5 * (ry + ly)], iod: norm2(rx - lx, ry - ly) };
}

/** `[ray_x, ray_y, iod / focal]`; `focalScale = fx / width`, principal point at the frame centre. */
export function cameraContext(lm: ArrayLike<number>, width: number, height: number, focalScale: number): [number, number, number] {
  if (!Number.isFinite(focalScale) || focalScale <= 0.0) throw new Error('focal_scale must be positive');
  const { center, iod } = eyeCenterAndIod(lm, width, height);
  if (!Number.isFinite(iod) || iod < 1e-8) throw new Error('degenerate interocular distance');
  const ratio = height / width;
  return [(center[0] - 0.5) / focalScale, (center[1] - 0.5 * ratio) / focalScale, iod / focalScale];
}

/** `(478,)`: 1 inside the image, 0 for a landmark placed outside it. */
export function landmarkValidity(lm: ArrayLike<number>): Float32Array {
  const out = new Float32Array(NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = lm[i * 3]!;
    const y = lm[i * 3 + 1]!;
    out[i] = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? 1 : 0;
  }
  return out;
}

/** Per-frame eye statistics `(4,)` (aperture, iris_y_in_aperture, upper_lid_v, brow_v) on the cloud. */
export function rowStatistics(c: ArrayLike<number>): Float64Array {
  const out = new Float64Array(4);
  for (const [[a, b], iris, upper, lower, brow, sign] of STAT_EYES) {
    const centreX = 0.5 * (c[a * 3]! + c[b * 3]!);
    const centreY = 0.5 * (c[a * 3 + 1]! + c[b * 3 + 1]!);
    let ux = c[b * 3]! - c[a * 3]!;
    let uy = c[b * 3 + 1]! - c[a * 3 + 1]!;
    const width = norm2(ux, uy);
    if (!Number.isFinite(width) || width < 1e-8) throw new Error('degenerate eye width');
    ux /= width;
    uy /= width;
    const vx = -uy;
    const vy = ux;
    const alongV = (i: number) => (((c[i * 3]! - centreX) * vx + (c[i * 3 + 1]! - centreY) * vy) / width) * sign;
    const up = alongV(upper);
    const lo = alongV(lower);
    const ir = alongV(iris);
    const br = alongV(brow);
    out[0]! += Math.abs(up - lo);
    out[1]! += ir - 0.5 * (up + lo);
    out[2]! += up;
    out[3]! += br;
  }
  for (let k = 0; k < 4; k++) out[k]! *= 0.5;
  return out;
}

/** `[right, left]` 6-point EAR on a cloud's x, y (V1's form; equal to the pixel-space EAR). */
export function eyeAspectRatiosOnCloud(c: ArrayLike<number>): [number, number] {
  const ear = (p: readonly number[]) => {
    const g = (i: number): [number, number] => [c[p[i]! * 3]!, c[p[i]! * 3 + 1]!];
    const [p1, p2, p3, p4, p5, p6] = [g(0), g(1), g(2), g(3), g(4), g(5)];
    const horizontal = norm2(p1[0] - p4[0], p1[1] - p4[1]);
    if (horizontal < 1e-8) return NaN;
    return (norm2(p2[0] - p6[0], p2[1] - p6[1]) + norm2(p3[0] - p5[0], p3[1] - p5[1])) / (2.0 * horizontal);
  };
  return [ear([33, 160, 158, 133, 153, 144]), ear([362, 385, 387, 263, 373, 380])];
}

/** Running median of the four statistics over a forgetting window; the training mean until warm. */
export class SubjectStatisticTracker {
  private readonly defaults: Float64Array;
  private readonly warmup: number;
  private readonly hists: DecayingHistogram1D[];
  private count = 0;

  constructor(trainingMean: readonly number[] = TRAINING_MEAN, warmup = STAT_WARMUP_FRAMES, windowS = STAT_WINDOW_S) {
    if (trainingMean.length !== 4) throw new Error('training_mean must have 4 entries');
    this.defaults = Float64Array.from(trainingMean);
    this.warmup = Math.trunc(warmup);
    this.hists = [0, 1, 2, 3].map(
      (k) => new DecayingHistogram1D(this.defaults[k]! + STAT_HIST_LO * 4.0, this.defaults[k]! + STAT_HIST_HI * 4.0, STAT_HIST_BIN, windowS)
    );
  }

  reset(): void {
    for (const h of this.hists) h.reset();
    this.count = 0;
  }

  /** Add one frame's statistics at time `t` (seconds); non-finite rows are ignored. */
  push(stats: ArrayLike<number>, t: number): Float64Array {
    let finite = true;
    for (let k = 0; k < 4; k++) if (!Number.isFinite(stats[k]!)) finite = false;
    if (finite) {
      for (let k = 0; k < 4; k++) this.hists[k]!.add(stats[k]!, t);
      this.count += 1;
    }
    return this.current();
  }

  current(): Float64Array {
    const out = Float64Array.from(this.defaults);
    if (this.count < this.warmup) return out;
    for (let k = 0; k < 4; k++) {
      const m = this.hists[k]!.median();
      if (m !== null) out[k] = m;
    }
    return out;
  }
}

export interface GazeNetInputs {
  cloud: Float32Array; // 1434
  context: Float32Array; // 7
  validity: Float32Array; // 478
}

/**
 * The per-session input assembler the native `GazeInputs` class ports. For each frame with a face:
 * `prepare` builds the network inputs from the tracker's CURRENT statistics (before this frame),
 * then `admit` adds this frame's statistics when the frame shows two open, unclipped eyes (mean raw
 * EAR ≥ STAT_ADMIT_MIN_EAR). `reset` on a new session.
 */
export class GazeInputAssembler {
  readonly tracker = new SubjectStatisticTracker();

  reset(): void {
    this.tracker.reset();
  }

  prepare(upright: ArrayLike<number>, width: number, height: number, focalScale: number): { inputs: GazeNetInputs; cloud64: Float64Array } {
    const cloud64 = weak3dCloud(upright, width, height);
    const ctx3 = cameraContext(upright, width, height, focalScale);
    const stats = this.tracker.current();
    const context = new Float32Array(7);
    context[0] = ctx3[0];
    context[1] = ctx3[1];
    context[2] = ctx3[2];
    for (let k = 0; k < 4; k++) context[3 + k] = stats[k]!;
    return { inputs: { cloud: new Float32Array(cloud64), context, validity: landmarkValidity(upright) }, cloud64 };
  }

  /** `tSec` is the record clock in seconds. Returns whether the frame was admitted. */
  admit(cloud64: Float64Array, tSec: number, earR: number, earL: number, clippedR: boolean, clippedL: boolean): boolean {
    if (clippedR || clippedL || !Number.isFinite(earR) || !Number.isFinite(earL)) return false;
    const meanEar = 0.5 * (earR + earL);
    probe('statAdmitEar', meanEar, STAT_ADMIT_MIN_EAR);
    if (meanEar < STAT_ADMIT_MIN_EAR) return false;
    let stats: Float64Array;
    try {
      stats = rowStatistics(cloud64);
    } catch {
      return false;
    }
    for (let k = 0; k < 4; k++) if (!Number.isFinite(stats[k]!)) return false;
    this.tracker.push(stats, tSec);
    return true;
  }
}
