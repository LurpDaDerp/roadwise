'use strict';
/**
 * Per-frame landmark features for the rule engines (`dms/features.py`).
 *
 * Everything eye-related is computed on the weak3d cloud (aspect-corrected, unit interocular
 * distance) so it is camera-distance invariant; the eye midpoint and the interocular distance
 * are in frame-width units for the geometry-shift detector.
 *
 * `FrameFeatures` is a PLAIN OBJECT whose field names are the Python dataclass field names.
 */

const {
  eyeAspectRatios,
  eyeCenterAndIod,
  eyeVisibility,
  irisXInEye,
  mouthAspectRatio,
  rowStatistics,
  check,
} = require('./gaze_inputs');
const { angularDistanceDeg, headDirection, meanArray, rotAt, vectorToAngles, DEG_PER_RAD } = require('./util');

const NAN = NaN;

/**
 * Landmark-derived measurements of one frame (all angles in degrees).
 * `ear` is the mean EAR over the eyes the far-eye gate still reads (visibility >= 0.5), NaN
 * when neither eye is readable; `ear_near` is the closure read used by the drowsiness rules.
 */
function FrameFeatures(fields = {}) {
  return Object.assign({
    t: 0.0,
    face_present: false,
    ear_right: NAN,
    ear_left: NAN,
    ear: NAN,
    ear_near: NAN,
    mar: NAN,
    iris_x_in_eye: NAN,
    iris_y_in_aperture: NAN,
    aperture: NAN,
    stats: [NAN, NAN, NAN, NAN],
    eye_visibility: [0.0, 0.0],
    in_frame_fraction: 0.0,
    eye_center: [NAN, NAN],
    iod: NAN,
    head_dir: null,
    head_yaw: NAN,
    head_pitch: NAN,
    head_roll: NAN,
  }, fields);
}

/**
 * `{dir, yaw, pitch, roll}` of the auxiliary head rotation `R` (row-major flat 9 or 3x3).
 * Yaw + = the face turned toward image right, pitch + = the face turned up,
 * roll = atan2(-R[0, 1], R[1, 1]) (+ = the top of the head leaning toward image right).
 */
function headAngles(rotation) {
  const dir = headDirection(rotation);
  const [yaw, pitch] = vectorToAngles(dir);
  const roll = Math.atan2(0.0 - rotAt(rotation, 0, 1), rotAt(rotation, 1, 1)) * DEG_PER_RAD;
  return { dir, yaw, pitch, roll };
}

/**
 * Features of a frame with a detected face.  `landmarks` are MediaPipe normalized (478, 3),
 * `cloud` the weak3d cloud of the same frame, `validity` the (478,) in-frame flags,
 * `rotation` the network's auxiliary head rotation (optional).
 */
function computeFeatures(t, landmarks, width, height, cloud, validity, rotation = null,
                         eyeGate = [0.45, 0.65], nearRatio = 0.85) {
  const [earR, earL] = eyeAspectRatios(cloud);
  const vis = eyeVisibility(cloud, eyeGate[0], eyeGate[1]);
  const readable = [];
  if (vis[0] >= 0.5 && Number.isFinite(earR)) readable.push(earR);
  if (vis[1] >= 0.5 && Number.isFinite(earL)) readable.push(earL);
  const ear = readable.length ? meanArray(readable) : NAN;
  const c = check(cloud);
  const wr = Math.sqrt((c[33 * 3] - c[133 * 3]) ** 2 + (c[33 * 3 + 1] - c[133 * 3 + 1]) ** 2);
  const wl = Math.sqrt((c[263 * 3] - c[362 * 3]) ** 2 + (c[263 * 3 + 1] - c[362 * 3 + 1]) ** 2);
  let earNear = ear;
  if (wr > 1e-8 && wl > 1e-8 && Math.min(wr, wl) / Math.max(wr, wl) < nearRatio) {
    const near = wr >= wl ? earR : earL;
    earNear = Number.isFinite(near) ? near : NAN;
  }
  const stats = rowStatistics(cloud);
  const { center, iod } = eyeCenterAndIod(landmarks, width, height);
  // `meanArray` only indexes its argument, and a float32 0/1 reads back as the exact same
  // double, so the Float64Array(478) copy this used to make per frame is pure garbage.
  const feat = FrameFeatures({
    t,
    face_present: true,
    ear_right: earR,
    ear_left: earL,
    ear,
    ear_near: earNear,
    mar: mouthAspectRatio(cloud),
    iris_x_in_eye: irisXInEye(cloud),
    iris_y_in_aperture: stats[1],
    aperture: stats[0],
    stats: Array.from(stats),
    eye_visibility: [vis[0], vis[1]],
    in_frame_fraction: meanArray(validity),
    eye_center: [center[0], center[1]],
    iod,
  });
  if (rotation !== null && rotation !== undefined) {
    const h = headAngles(rotation);
    feat.head_dir = h.dir;
    feat.head_yaw = h.yaw;
    feat.head_pitch = h.pitch;
    feat.head_roll = h.roll;
  }
  return feat;
}

/** The features of a frame without a face (everything NaN, `face_present` false). */
function emptyFeatures(t) {
  return FrameFeatures({ t, face_present: false });
}

/**
 * Angle between the frame's head direction and a reference direction (the driver's resting
 * head pose); `null` when either is unknown.
 */
function headTurnDeg(feat, headModeDir) {
  if (feat.head_dir === null || feat.head_dir === undefined || headModeDir === null || headModeDir === undefined) {
    return null;
  }
  return angularDistanceDeg(feat.head_dir, headModeDir);
}

module.exports = { FrameFeatures, headAngles, computeFeatures, emptyFeatures, headTurnDeg, NAN };
