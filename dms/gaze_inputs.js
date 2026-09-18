'use strict';
/**
 * MediaPipe landmarks -> the gaze network's inputs (weak3d cloud, camera context, validity,
 * subject statistic) and the landmark geometry helpers.  Port of `dms/gaze_inputs.py`.
 *
 * Coordinate convention: OpenCV camera axes, `+x` image right, `+y` image down, `+z` away
 * from the camera.  Stored gaze `s = diag(1, 1, -1) p`.
 *
 * Landmark / cloud arrays are accepted either as a FLAT array of 478*3 numbers (row-major
 * `[x0, y0, z0, x1, ...]`, any Array / Float32Array / Float64Array) or as an array of 478
 * `[x, y, z]` triples.  Everything is computed in float64; `weak3dCloud` returns a
 * Float64Array so the feature maths matches the reference bit for bit (`monitor.prepareInputs`
 * makes the Float32Array copy the network wants).
 */

const { DecayingHistogram1D, sumArray } = require('./util');

const NUM_LANDMARKS = 478;
const OUTER_EYE_CORNERS = [33, 263];
const RIGHT_EYE_CORNERS = [33, 133];
const LEFT_EYE_CORNERS = [263, 362];
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const RIGHT_IRIS = [468, 469, 470, 471, 472];
const LEFT_IRIS = [473, 474, 475, 476, 477];
const RIGHT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const LEFT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
// MediaPipe 6-point eye aspect ratio landmarks (p1..p6): outer corner, upper x2, inner corner, lower x2
const EAR_RIGHT = [33, 160, 158, 133, 153, 144];
const EAR_LEFT = [362, 385, 387, 263, 373, 380];
const MOUTH_INNER = [13, 14];      // upper / lower inner lip
const MOUTH_CORNERS = [78, 308];   // inner mouth corners
const STAT_NAMES = ['aperture', 'iris_y_in_aperture', 'upper_lid_v', 'brow_v'];
// [[cornerA, cornerB], iris, upper, lower, brow, sign]
const STAT_EYES = [
  [[33, 133], 468, 159, 145, 105, 1.0],
  [[263, 362], 473, 386, 374, 334, -1.0],
];

/** Flatten / validate landmarks into a Float64Array(478*3); throws like the reference `_check`. */
function check(points) {
  if (points instanceof Float64Array && points.length === NUM_LANDMARKS * 3) return points;
  if (ArrayBuffer.isView(points) || (Array.isArray(points) && typeof points[0] === 'number')) {
    if (points.length !== NUM_LANDMARKS * 3) {
      throw new Error(`landmarks must have shape (${NUM_LANDMARKS}, 3), got length ${points.length}`);
    }
    // `new Float64Array(src)` is the engine's element-wise convert; `Float64Array.from` walks the
    // iterator protocol. Same values (float32 -> float64 is exact), much cheaper per frame.
    return new Float64Array(points);
  }
  if (Array.isArray(points) && points.length === NUM_LANDMARKS) {
    const out = new Float64Array(NUM_LANDMARKS * 3);
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      const p = points[i];
      if (!p || p.length !== 3) throw new Error(`landmarks must have shape (${NUM_LANDMARKS}, 3)`);
      out[i * 3] = p[0];
      out[i * 3 + 1] = p[1];
      out[i * 3 + 2] = p[2];
    }
    return out;
  }
  throw new Error(`landmarks must have shape (${NUM_LANDMARKS}, 3)`);
}

/**
 * Validate a landmark / cloud source and return something indexable as
 * `[x0, y0, z0, x1, ...]` WITHOUT copying when the input is already flat (a Float32Array,
 * Float64Array or number[]).
 *
 * Every consumer that uses this only READS the values, and reading a float32 element yields
 * exactly the same double as reading it out of a Float64Array copy, so the results are
 * bit-identical to `check` while ~11 KB of garbage per call disappears. The nested
 * `[[x, y, z], ...]` form still goes through `check` (the tests use it; the phone never does).
 */
function checkFlat(points) {
  if (ArrayBuffer.isView(points) || (Array.isArray(points) && typeof points[0] === 'number')) {
    if (points.length !== NUM_LANDMARKS * 3) {
      throw new Error(`landmarks must have shape (${NUM_LANDMARKS}, 3), got length ${points.length}`);
    }
    return points;
  }
  return check(points);
}

/** `check`, but the result is always a fresh Float64Array the caller may mutate in place. */
function checkCopy(points) {
  const p = check(points);
  return p === points ? new Float64Array(p) : p;
}

function norm2(x, y) {
  return Math.sqrt(x * x + y * y);
}

/** MediaPipe normalized `(x/W, y/H, z/W)` -> all axes in frame-width units. */
function aspectCorrected(landmarks, width, height) {
  const p = checkCopy(landmarks);
  const ratio = height / width;
  for (let i = 0; i < NUM_LANDMARKS; i++) p[i * 3 + 1] *= ratio;
  return p;
}

/** Eye-centred, interocular-normalized weak-3D cloud: the `cloud` network input. */
function weak3dCloud(landmarks, width, height) {
  // The aspect correction is folded into this single pass: `aspectCorrected` would allocate two
  // more Float64Array(1434) per frame for values that are read once. The arithmetic is unchanged
  // (`y * ratio` is the same double whether or not it is stored in a scratch array first).
  const p = checkFlat(landmarks);
  const ratio = height / width;
  const r = OUTER_EYE_CORNERS[0], l = OUTER_EYE_CORNERS[1];
  const cx = 0.5 * (p[r * 3] + p[l * 3]);
  const cy = 0.5 * (p[r * 3 + 1] * ratio + p[l * 3 + 1] * ratio);
  const cz = 0.5 * (p[r * 3 + 2] + p[l * 3 + 2]);
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = p[i * 3] - cx;
    out[i * 3 + 1] = p[i * 3 + 1] * ratio - cy;
    out[i * 3 + 2] = p[i * 3 + 2] - cz;
  }
  const scale = norm2(out[r * 3] - out[l * 3], out[r * 3 + 1] - out[l * 3 + 1]);
  if (!Number.isFinite(scale) || scale < 1e-8) throw new Error('degenerate interocular distance');
  for (let i = 0; i < out.length; i++) out[i] /= scale;
  return out;
}

/** `[center (2), iod]`: eye midpoint (frame-width units) and the projected interocular distance. */
function eyeCenterAndIod(landmarks, width, height) {
  // Two landmarks are needed, so the whole cloud is neither copied nor aspect-corrected.
  const p = checkFlat(landmarks);
  const ratio = height / width;
  const r = OUTER_EYE_CORNERS[0], l = OUTER_EYE_CORNERS[1];
  const rx = p[r * 3], ry = p[r * 3 + 1] * ratio;
  const lx = p[l * 3], ly = p[l * 3 + 1] * ratio;
  const center = [0.5 * (rx + lx), 0.5 * (ry + ly)];
  const iod = norm2(rx - lx, ry - ly);
  return { center, iod };
}

/**
 * `[ray_x, ray_y, iod / focal]`: the calibrated ray through the eye midpoint and the
 * projected-size-to-focal ratio; `focalScale = fx / width`; principal point = frame centre.
 */
function cameraContext(landmarks, width, height, focalScale) {
  const focal = focalScale;
  if (!Number.isFinite(focal) || focal <= 0.0) throw new Error('focal_scale must be positive');
  const { center, iod } = eyeCenterAndIod(landmarks, width, height);
  if (!Number.isFinite(iod) || iod < 1e-8) throw new Error('degenerate interocular distance');
  const ratio = height / width;
  return [(center[0] - 0.5) / focal, (center[1] - 0.5 * ratio) / focal, iod / focal];
}

/** `(478,)` float32: 1 inside the image, 0 for a landmark placed outside it. */
function landmarkValidity(landmarks, margin = 0.0) {
  const p = checkFlat(landmarks);
  const out = new Float32Array(NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    out[i] = x >= -margin && x <= 1.0 + margin && y >= -margin && y <= 1.0 + margin ? 1 : 0;
  }
  return out;
}

/**
 * Per-frame eye statistics `(4,)` in eye widths (aperture, iris_y_in_aperture, upper_lid_v,
 * brow_v), mean of both eyes with the left eye's signed axes flipped.
 */
function rowStatistics(cloud) {
  const c = checkFlat(cloud);
  const out = new Float64Array(4);
  for (const [[a, b], iris, upper, lower, brow, sign] of STAT_EYES) {
    const centreX = 0.5 * (c[a * 3] + c[b * 3]);
    const centreY = 0.5 * (c[a * 3 + 1] + c[b * 3 + 1]);
    let ux = c[b * 3] - c[a * 3];
    let uy = c[b * 3 + 1] - c[a * 3 + 1];
    const width = norm2(ux, uy);
    if (!Number.isFinite(width) || width < 1e-8) throw new Error('degenerate eye width');
    ux /= width;
    uy /= width;
    const vx = -uy, vy = ux;
    const alongV = (i) => (((c[i * 3] - centreX) * vx + (c[i * 3 + 1] - centreY) * vy) / width) * sign;
    const up = alongV(upper);
    const lo = alongV(lower);
    const ir = alongV(iris);
    const br = alongV(brow);
    out[0] += Math.abs(up - lo);
    out[1] += ir - 0.5 * (up + lo);
    out[2] += up;
    out[3] += br;
  }
  for (let k = 0; k < 4; k++) out[k] *= 0.5;
  return out;
}

/**
 * Mean horizontal iris offset along each eye's axis (outer -> inner corner) in corner widths,
 * the LEFT eye's sign flipped.  Positive = irises toward image right.
 */
function irisXInEye(cloud) {
  const c = checkFlat(cloud);
  let total = 0.0;
  const eyes = [[[33, 133], 468, 1.0], [[263, 362], 473, -1.0]];
  for (const [[a, b], iris, sign] of eyes) {
    const ux = c[b * 3] - c[a * 3];
    const uy = c[b * 3 + 1] - c[a * 3 + 1];
    const width = norm2(ux, uy);
    if (width < 1e-8) return NaN;
    const centreX = 0.5 * (c[a * 3] + c[b * 3]);
    const centreY = 0.5 * (c[a * 3 + 1] + c[b * 3 + 1]);
    const dot = (c[iris * 3] - centreX) * (ux / width) + (c[iris * 3 + 1] - centreY) * (uy / width);
    total += (sign * dot) / width;
  }
  return 0.5 * total;
}

/** `[right, left]` 6-point EAR on the cloud's x, y. */
function eyeAspectRatios(cloud) {
  const c = checkFlat(cloud);
  const ear = (p) => {
    const g = (i) => [c[p[i] * 3], c[p[i] * 3 + 1]];
    const p1 = g(0), p2 = g(1), p3 = g(2), p4 = g(3), p5 = g(4), p6 = g(5);
    const horizontal = norm2(p1[0] - p4[0], p1[1] - p4[1]);
    if (horizontal < 1e-8) return NaN;
    return (norm2(p2[0] - p6[0], p2[1] - p6[1]) + norm2(p3[0] - p5[0], p3[1] - p5[1])) / (2.0 * horizontal);
  };
  return [ear(EAR_RIGHT), ear(EAR_LEFT)];
}

function mouthAspectRatio(cloud) {
  const c = checkFlat(cloud);
  const a = MOUTH_CORNERS[0], b = MOUTH_CORNERS[1];
  const width = norm2(c[a * 3] - c[b * 3], c[a * 3 + 1] - c[b * 3 + 1]);
  if (width < 1e-8) return NaN;
  const u = MOUTH_INNER[0], l = MOUTH_INNER[1];
  return norm2(c[u * 3] - c[l * 3], c[u * 3 + 1] - c[l * 3 + 1]) / width;
}

/** `[right, left]` visibility of each eye under the in-graph far-eye gate. */
function eyeVisibility(cloud, low = 0.45, high = 0.65) {
  const c = checkFlat(cloud);
  const wr = norm2(c[33 * 3] - c[133 * 3], c[33 * 3 + 1] - c[133 * 3 + 1]);
  const wl = norm2(c[263 * 3] - c[362 * 3], c[263 * 3 + 1] - c[362 * 3 + 1]);
  if (high <= low) return [1.0, 1.0];
  if (wr < 1e-8 || wl < 1e-8) return [0.0, 0.0];
  const span = high - low;
  const clip = (v) => (v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v);
  return [clip((wr / wl - low) / span), clip((wl / wr - low) / span)];
}

function mirrorCloud(cloud, permutation) {
  const c = checkFlat(cloud);
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const src = permutation[i];
    out[i * 3] = -c[src * 3];
    out[i * 3 + 1] = c[src * 3 + 1];
    out[i * 3 + 2] = c[src * 3 + 2];
  }
  return out;
}

function mirrorContext(context) {
  const out = Array.from(context);
  out[0] = -out[0];
  return out;
}

function mirrorValidity(validity, permutation) {
  const out = new Float32Array(NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) out[i] = validity[permutation[i]];
  return out;
}

/**
 * Running median of the four per-frame statistics over a bounded, forgetting window,
 * returning the training-population mean until `warmup` frames have been admitted.
 */
class SubjectStatisticTracker {
  constructor(trainingMean, opts = {}) {
    const { warmup = 30, windowS = 120.0, lo = -0.2, hi = 0.2, binWidth = 0.0025 } = opts;
    this.default = Float64Array.from(trainingMean);
    if (this.default.length !== 4) throw new Error('training_mean must have 4 entries');
    this.warmup = Math.trunc(warmup);
    this.hists = [];
    for (let k = 0; k < 4; k++) {
      this.hists.push(new DecayingHistogram1D(this.default[k] + lo * 4.0, this.default[k] + hi * 4.0, binWidth, windowS));
    }
    this.count = 0;
    this.last = Float64Array.from(this.default);
  }

  reset() {
    for (const h of this.hists) h.reset();
    this.count = 0;
    this.last = Float64Array.from(this.default);
  }

  push(stats, t) {
    const s = stats;
    let finite = true;
    for (let k = 0; k < 4; k++) if (!Number.isFinite(s[k])) finite = false;
    if (finite) {
      for (let k = 0; k < 4; k++) this.hists[k].add(s[k], t);
      this.count += 1;
    }
    return this.current();
  }

  current() {
    if (this.count < this.warmup) {
      this.last = Float64Array.from(this.default);
      return this.last;
    }
    const out = Float64Array.from(this.default);
    for (let k = 0; k < 4; k++) {
      const m = this.hists[k].median();
      if (m !== null) out[k] = m;
    }
    this.last = out;
    return out;
  }
}

module.exports = {
  NUM_LANDMARKS,
  OUTER_EYE_CORNERS,
  RIGHT_EYE_CORNERS,
  LEFT_EYE_CORNERS,
  RIGHT_EYE,
  LEFT_EYE,
  RIGHT_IRIS,
  LEFT_IRIS,
  RIGHT_BROW,
  LEFT_BROW,
  EAR_RIGHT,
  EAR_LEFT,
  MOUTH_INNER,
  MOUTH_CORNERS,
  STAT_NAMES,
  STAT_EYES,
  check,
  checkFlat,
  aspectCorrected,
  weak3dCloud,
  eyeCenterAndIod,
  cameraContext,
  landmarkValidity,
  rowStatistics,
  irisXInEye,
  eyeAspectRatios,
  mouthAspectRatio,
  eyeVisibility,
  mirrorCloud,
  mirrorContext,
  mirrorValidity,
  SubjectStatisticTracker,
  sumArray,
};
