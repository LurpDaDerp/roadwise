'use strict';
/**
 * The fixture comparisons themselves, as functions returning a `Cmp`.
 * `*.test.js` asserts on them; `tools/parity_report.js` tabulates them into PARITY.md.
 */

const {
  BucketWindowSum, CausalMedian, DecayingHistogram1D, DecayingHistogram2D, EventCounter,
  TimeWindowSum, anglesToVector, angularDistanceDeg, headDirection, pairwiseSum, referenceRotation,
  relativeAngles, unit, vectorToAngles, wrapDeg,
} = require('../util');
const { Event, EventType } = require('../alerts');
const { robustMode } = require('../calibration');
const { computeFeatures, headAngles } = require('../features');
const {
  NUM_LANDMARKS, SubjectStatisticTracker, cameraContext, eyeAspectRatios, eyeCenterAndIod,
  eyeVisibility, irisXInEye, landmarkValidity, mirrorCloud, mirrorContext, mirrorValidity,
  mouthAspectRatio, rowStatistics, weak3dCloud,
} = require('../gaze_inputs');
const { loadFixture, Cmp } = require('./helpers');

function nan(v) {
  return v === null ? NaN : v;
}

// ------------------------------------------------------------------ util
function checkHist1d(fx, name, cmp) {
  const c = fx[name];
  const h = new DecayingHistogram1D(c.lo, c.hi, c.bin, c.tau);
  c.adds.forEach(([x, t, w], i) => {
    h.add(nan(x), t, w);
    const probe = c.probes[i];
    if (probe.length === 4) {
      cmp.num(`${name}.mass@${i}`, h.mass(), probe[0]);
      cmp.num(`${name}.q02@${i}`, h.quantile(0.02), probe[1]);
      cmp.num(`${name}.q50@${i}`, h.quantile(0.5), probe[2]);
      cmp.num(`${name}.q95@${i}`, h.quantile(0.95), probe[3]);
    } else {
      cmp.num(`${name}.mass@${i}`, h.mass(), probe[0]);
      cmp.num(`${name}.median@${i}`, h.median(), probe[1]);
      cmp.num(`${name}.q98@${i}`, h.quantile(0.98), probe[2]);
    }
  });
}

function checkHist2d(fx, cmp) {
  const c = fx.hist2d;
  const g = new DecayingHistogram2D(c.x_range, c.y_range, c.bin, c.tau);
  let p = 0;
  c.adds.forEach(([x, y, t, w], i) => {
    g.add(x, y, t, w);
    if (p < c.probes.length && c.probes[p].i === i) {
      const probe = c.probes[p];
      cmp.num(`mass@${i}`, g.mass(), probe.mass);
      const mode = g.mode(c.smooth_sigma_bins);
      if (probe.mode === null) cmp.exact(`mode@${i}`, mode, null);
      else for (let k = 0; k < 3; k++) cmp.num(`mode[${k}]@${i}`, mode[k], probe.mode[k]);
      const rm = robustMode(g.counts, g.nx, g.ny, g.x0, g.y0, g.bin, c.search_sigma_deg, c.refine_radius_deg);
      if (probe.robust_mode === null) cmp.exact(`robust_mode@${i}`, rm, null);
      else for (let k = 0; k < 3; k++) cmp.num(`robust_mode[${k}]@${i}`, rm[k], probe.robust_mode[k]);
      cmp.num(`mass_within@${i}`, g.massWithin(6.0, -3.0, c.concentration_radius_deg), probe.mass_within);
      const s = g.smoothed(c.smooth_sigma_bins);
      cmp.num(`smoothed_sum@${i}`, pairwiseSum(s, 0, s.length), probe.smoothed_sum);
      p += 1;
    }
  });
  cmp.exact('probes_consumed', p, c.probes.length);
  const copy = fx.hist2d_copy;
  const srcShort = new DecayingHistogram2D(c.x_range, c.y_range, c.bin, 45.0);
  c.adds.slice(0, copy.n_src).forEach(([x, y, t, w]) => srcShort.add(x, y, t, w));
  const dst = new DecayingHistogram2D(c.x_range, c.y_range, c.bin, c.tau);
  c.adds.slice(0, copy.n_dst).forEach(([x, y, t, w]) => dst.add(x, y, t, w));
  dst.copyFrom(srcShort);
  cmp.num('copy.mass', dst.mass(), copy.mass);
  const m = dst.mode(c.smooth_sigma_bins);
  for (let k = 0; k < 3; k++) cmp.num(`copy.mode[${k}]`, m[k], copy.mode[k]);
}

function checkWindows(fx, cmp) {
  const cm = new CausalMedian(fx.causal_median.n);
  fx.causal_median.pushes.forEach((x, i) => cmp.num(`causal_median@${i}`, cm.push(x), fx.causal_median.results[i]));

  const tw = new TimeWindowSum(fx.time_window_sum.window);
  fx.time_window_sum.ops.forEach((op, i) => {
    tw.push(op.t, op.v, op.dt);
    cmp.num(`total@${i}`, tw.total(op.t), op.total);
    cmp.num(`signed@${i}`, tw.total(op.t, false), op.signed);
    cmp.num(`span@${i}`, tw.span(), op.span);
  });

  const b = new BucketWindowSum(fx.bucket_window_sum.window, fx.bucket_window_sum.bucket);
  cmp.exact('ring_size', b.n, 181);
  fx.bucket_window_sum.ops.forEach((op, i) => {
    b.push(op.t, op.a, op.b);
    if (op.sa !== undefined) {
      const [sa, sb] = b.totals(op.t);
      cmp.num(`sa@${i}`, sa, op.sa);
      cmp.num(`sb@${i}`, sb, op.sb);
    }
  });
  const last = fx.bucket_window_sum.ops[fx.bucket_window_sum.ops.length - 1];
  const [fa, fb] = b.totals(last.t);
  cmp.num('bucket.final.a', fa, fx.bucket_window_sum.final[0]);
  cmp.num('bucket.final.b', fb, fx.bucket_window_sum.final[1]);
  const [ea, eb] = b.totals(10000.0);
  cmp.num('bucket.expired.a', ea, fx.bucket_window_sum.expired[0]);
  cmp.num('bucket.expired.b', eb, fx.bucket_window_sum.expired[1]);

  const ec = new EventCounter(fx.event_counter.window);
  fx.event_counter.ops.forEach((op, i) => {
    ec.push(op.t);
    cmp.exact(`count@${i}`, ec.count(op.t), op.count);
  });
}

function checkAngles(fx, cmp) {
  const c = fx.angles;
  c.vectors.forEach((v, i) => {
    const u = unit(v.v);
    for (let k = 0; k < 3; k++) cmp.num(`unit[${k}]@${i}`, u[k], v.unit[k]);
    const [yaw, pitch] = vectorToAngles(v.v);
    cmp.num(`yaw@${i}`, yaw, v.yaw);
    cmp.num(`pitch@${i}`, pitch, v.pitch);
    const back = anglesToVector(yaw, pitch);
    for (let k = 0; k < 3; k++) cmp.num(`back[${k}]@${i}`, back[k], v.back[k]);
    const R = referenceRotation(v.v);
    for (let k = 0; k < 9; k++) cmp.num(`R[${k}]@${i}`, R[k], v.reference_rotation[k]);
  });
  c.pairs.forEach((p, i) => {
    cmp.num(`distance@${i}`, angularDistanceDeg(p.a, p.b), p.distance);
    const rel = relativeAngles(p.a, p.b);
    cmp.num(`rel0@${i}`, rel[0], p.relative[0]);
    cmp.num(`rel1@${i}`, rel[1], p.relative[1]);
  });
  c.rotations.forEach((r, i) => {
    const d = headDirection(r.rotation);
    for (let k = 0; k < 3; k++) cmp.num(`head_dir[${k}]@${i}`, d[k], r.head_dir[k]);
  });
  c.wraps.forEach((w, i) => cmp.num(`wrap@${i}`, wrapDeg(w.a), w.wrapped));
  c.degenerate.forEach((d, i) => {
    const R = referenceRotation(d.v);
    for (let k = 0; k < 9; k++) cmp.num(`degenerate[${i}][${k}]`, R[k], d.reference_rotation[k]);
  });
}

function checkEventRounding(fx, cmp) {
  fx.event_rounding.forEach((c, i) => {
    const expected = c.dict;
    const type = expected.type === 'BLINK' ? EventType.BLINK : EventType.LONG_GLANCE;
    const extra = expected.class !== undefined ? { class: expected.class } : {};
    const e = new Event(type, c.t, c.t_start, c.value, expected.detail, extra);
    cmp.event(`event[${i}]`, e.toDict(), expected);
  });
}

/** Every util case in one Cmp (the report's `util_cases.json` row). */
function checkUtil(tol = 1e-6) {
  const fx = loadFixture('util_cases');
  const cmp = new Cmp('util_cases.json', tol);
  checkHist1d(fx, 'hist1d', cmp);
  checkHist1d(fx, 'hist1d_decay', cmp);
  checkHist2d(fx, cmp);
  checkWindows(fx, cmp);
  checkAngles(fx, cmp);
  checkEventRounding(fx, cmp);
  cmp.frames = fx.hist1d.adds.length + fx.hist2d.adds.length + fx.time_window_sum.ops.length
    + fx.bucket_window_sum.ops.length;
  cmp.comparedFrames = cmp.frames;
  return cmp;
}

// ------------------------------------------------------------------ gaze inputs / features
function checkGazeInputs(tol = 1e-6) {
  const fx = loadFixture('gaze_inputs_cases');
  const perm = loadFixture('mirror_permutation_478');
  const cmp = new Cmp('gaze_inputs_cases.json', tol);
  fx.cases.forEach((c, k) => {
    const lm = c.landmarks;
    const cloud = weak3dCloud(lm, c.width, c.height);
    for (let i = 0; i < cloud.length; i++) cmp.num(`cloud[${i}]@${k}`, cloud[i], c.cloud[i]);
    const ctx = cameraContext(lm, c.width, c.height, c.focal_scale);
    for (let i = 0; i < 3; i++) cmp.num(`context3[${i}]@${k}`, ctx[i], c.context3[i]);
    const validity = landmarkValidity(lm);
    for (let i = 0; i < NUM_LANDMARKS; i++) cmp.exact(`validity[${i}]@${k}`, validity[i], c.validity[i]);
    const stats = rowStatistics(cloud);
    for (let i = 0; i < 4; i++) cmp.num(`row_statistics[${i}]@${k}`, stats[i], c.row_statistics[i]);
    cmp.num(`iris_x_in_eye@${k}`, irisXInEye(cloud), c.iris_x_in_eye);
    const ear = eyeAspectRatios(cloud);
    cmp.num(`ear_right@${k}`, ear[0], c.eye_aspect_ratios[0]);
    cmp.num(`ear_left@${k}`, ear[1], c.eye_aspect_ratios[1]);
    cmp.num(`mar@${k}`, mouthAspectRatio(cloud), c.mouth_aspect_ratio);
    const vis = eyeVisibility(cloud);
    cmp.num(`vis0@${k}`, vis[0], c.eye_visibility[0]);
    cmp.num(`vis1@${k}`, vis[1], c.eye_visibility[1]);
    const { center, iod } = eyeCenterAndIod(lm, c.width, c.height);
    cmp.num(`eye_center0@${k}`, center[0], c.eye_center[0]);
    cmp.num(`eye_center1@${k}`, center[1], c.eye_center[1]);
    cmp.num(`iod@${k}`, iod, c.iod);
    if (c.mirror_cloud) {
      const mc = mirrorCloud(cloud, perm);
      for (let i = 0; i < mc.length; i++) cmp.num(`mirror_cloud[${i}]@${k}`, mc[i], c.mirror_cloud[i]);
      const mctx = mirrorContext([ctx[0], ctx[1], ctx[2], 0.3, -0.02, -0.21, -0.9]);
      for (let i = 0; i < 7; i++) cmp.num(`mirror_context[${i}]@${k}`, mctx[i], c.mirror_context[i]);
      const mv = mirrorValidity(validity, perm);
      for (let i = 0; i < NUM_LANDMARKS; i++) cmp.exact(`mirror_validity[${i}]@${k}`, mv[i], c.mirror_validity[i]);
    }
  });
  cmp.frames = fx.cases.length;
  cmp.comparedFrames = fx.cases.length;
  return cmp;
}

function checkStatsTracker(tol = 1e-6) {
  const fx = loadFixture('gaze_inputs_stats_tracker');
  const cmp = new Cmp('gaze_inputs_stats_tracker.json', tol);
  const tracker = new SubjectStatisticTracker(fx.training_mean, { warmup: fx.warmup, windowS: fx.window_s });
  fx.pushes.forEach((s, i) => {
    const cur = tracker.push(s.map((v) => (v === null ? NaN : v)), fx.t[i]);
    for (let k = 0; k < 4; k++) cmp.num(`current[${k}]@${i}`, cur[k], fx.current[i][k]);
  });
  cmp.frames = fx.pushes.length;
  cmp.comparedFrames = fx.pushes.length;
  return cmp;
}

const FEATURE_SCALARS = ['t', 'ear_right', 'ear_left', 'ear', 'ear_near', 'mar', 'iris_x_in_eye',
                         'iris_y_in_aperture', 'aperture', 'in_frame_fraction', 'iod',
                         'head_yaw', 'head_pitch', 'head_roll'];

function checkFeatures(tol = 1e-6) {
  const fx = loadFixture('features_cases');
  const cmp = new Cmp('features_cases.json', tol);
  fx.cases.forEach((c, k) => {
    const cloud = weak3dCloud(c.landmarks, c.width, c.height);
    const validity = landmarkValidity(c.landmarks);
    const f = computeFeatures(c.t, c.landmarks, c.width, c.height, cloud, validity, c.rotation);
    const e = c.features;
    cmp.exact(`face_present@${k}`, f.face_present, e.face_present);
    for (const name of FEATURE_SCALARS) cmp.num(`${name}@${k}`, f[name], e[name]);
    for (let i = 0; i < 4; i++) cmp.num(`stats[${i}]@${k}`, f.stats[i], e.stats[i]);
    for (let i = 0; i < 2; i++) cmp.num(`eye_visibility[${i}]@${k}`, f.eye_visibility[i], e.eye_visibility[i]);
    for (let i = 0; i < 2; i++) cmp.num(`eye_center[${i}]@${k}`, f.eye_center[i], e.eye_center[i]);
    if (e.head_dir === null) cmp.exact(`head_dir@${k}`, f.head_dir, null);
    else for (let i = 0; i < 3; i++) cmp.num(`head_dir[${i}]@${k}`, f.head_dir[i], e.head_dir[i]);
    if (c.head_angles) {
      const h = headAngles(c.rotation);
      for (let i = 0; i < 3; i++) cmp.num(`head_angles.dir[${i}]@${k}`, h.dir[i], c.head_angles.dir[i]);
      cmp.num(`head_angles.yaw@${k}`, h.yaw, c.head_angles.yaw);
      cmp.num(`head_angles.pitch@${k}`, h.pitch, c.head_angles.pitch);
      cmp.num(`head_angles.roll@${k}`, h.roll, c.head_angles.roll);
    }
  });
  cmp.frames = fx.cases.length;
  cmp.comparedFrames = fx.cases.length;
  return cmp;
}

module.exports = {
  checkUtil, checkHist1d, checkHist2d, checkWindows, checkAngles, checkEventRounding,
  checkGazeInputs, checkStatsTracker, checkFeatures,
};
