'use strict';
/**
 * JS port of `tests/synthetic.py` + the `tools/behavior_eval.py` scenario harness.
 *
 * The RNG is a small seeded PRNG (mulberry32 + Box-Muller), NOT numpy's stream: the behaviour
 * tests check the rules under a different noise realisation, while the fixture tests cover
 * bit-level parity.
 */

const { DriverMonitor } = require('../monitor');
const { FrameFeatures } = require('../features');
const { defaultConfig } = require('../config');
const { anglesToVector, pyMod } = require('../util');

const WARMUP_S = 150.0;
const EAR_OPEN = 0.32;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller on a mulberry32 stream. */
function gaussianSource(seed) {
  const rand = mulberry32(seed);
  let spare = null;
  return function normal(mu = 0.0, sigma = 1.0) {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return mu + sigma * v;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = 2 * rand() - 1;
      v = 2 * rand() - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return mu + sigma * (u * f);
  };
}

/** Frames of a driver whose road-attending gaze sits at `(yaw0, pitch0)` in the camera frame. */
class SyntheticDriver {
  constructor(opts = {}) {
    const {
      yaw0 = 5.0, pitch0 = -3.0, fps = 30.0, noiseDeg = 2.0, seed = 0,
      headYaw = 4.0, headPitch = -2.0, irisX0 = -0.02, irisY0 = -0.01, earOpen = 0.32,
    } = opts;
    this.yaw0 = yaw0;
    this.pitch0 = pitch0;
    this.fps = fps;
    this.noise = noiseDeg;
    this.normal = gaussianSource(seed * 7919 + 12345);
    this.head_yaw0 = headYaw;
    this.head_pitch0 = headPitch;
    this.iris_x0 = irisX0;
    this.iris_y0 = irisY0;
    this.ear_open = earOpen;
    this.k = 0;
    this.t0 = 0.0;
  }

  get t() {
    return this.t0 + this.k / this.fps;
  }

  frame(kw = {}) {
    const {
      left = 0.0, up = 0.0, head_follow = 0.5, eyes_open = true, ear = null, mar = 0.2,
      face = true, noise = null, in_frame = 1.0, iod = 0.12, center = [0.5, 0.4],
      head_left = null, head_up = null,
    } = kw;
    const t = this.t;
    this.k += 1;
    if (!face) return { t, gaze: null, rotation: null, feat: FrameFeatures({ t, face_present: false }) };
    const n = noise === null ? this.noise : noise;
    const gy = this.yaw0 + left + this.normal(0, n);
    const gp = this.pitch0 + up + this.normal(0, n);
    const gaze = anglesToVector(gy, gp);
    const hy = this.head_yaw0 + (head_left === null ? head_follow * left : head_left) + this.normal(0, 0.5);
    const hp = this.head_pitch0 + (head_up === null ? head_follow * up : head_up) + this.normal(0, 0.5);
    const headDir = anglesToVector(hy, hp);
    const eyeLeft = head_left === null ? (1.0 - head_follow) * left : left - head_left;
    const eyeUp = head_up === null ? (1.0 - head_follow) * up : up - head_up;
    const ix = this.iris_x0 + 0.008 * eyeLeft + this.normal(0, 0.003);
    const iy = this.iris_y0 + 0.005 * eyeUp + this.normal(0, 0.003);
    const e = ear === null ? (eyes_open ? this.ear_open : 0.06) : ear;
    const aperture = e * 1.0;
    const feat = FrameFeatures({
      t, face_present: true, ear_right: e, ear_left: e, ear: e, mar, iris_x_in_eye: ix,
      iris_y_in_aperture: iy, aperture, stats: [aperture, iy, -0.21, -0.9], eye_visibility: [1.0, 1.0],
      in_frame_fraction: in_frame, eye_center: [center[0], center[1]], iod,
      head_dir: headDir, head_yaw: hy, head_pitch: hp, head_roll: 0.0,
    });
    return { t, gaze, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], feat };
  }
}

/** One synthetic driver through a fresh monitor: WARMUP_S of normal driving, then the scenario. */
class Run {
  constructor(fps, opts = {}) {
    const { seed = 0, speed = null, blinkPeriodS = 4.0, config = null } = opts;
    this.mon = new DriverMonitor(config || defaultConfig());
    if (speed !== null) this.mon.setVehicleSpeed(speed);
    this.d = new SyntheticDriver({ fps, seed });
    this.fps = fps;
    this.blink_period_s = blinkPeriodS;
    this.outs = [];
    this.seg(WARMUP_S);
    this.t_test = this.d.t;
    this.confidence_at_test = this.outs[this.outs.length - 1].confidence;
    this.t_mark = null;
  }

  seg(seconds, kw = {}) {
    const n = Math.round(seconds * this.fps);
    for (let i = 0; i < n; i++) {
      const t = this.d.t;
      const k = {};
      for (const key of Object.keys(kw)) k[key] = typeof kw[key] === 'function' ? kw[key](t) : kw[key];
      if (this.blink_period_s && k.ear === undefined && (k.eyes_open === undefined || k.eyes_open)
          && (k.face === undefined || k.face) && this._inBlink(t)) {
        k.ear = 0.06;
      }
      const f = this.d.frame(k);
      this.outs.push(this.mon.processPrediction(f.t, f.gaze, f.rotation, f.feat));
    }
  }

  _inBlink(t) {
    const p = this.blink_period_s;
    const k = Math.floor(t / p);
    for (const kk of [k - 1, k]) {
      const start = kk * p + 0.8 * p * pyMod(kk * 0.6180339887, 1.0);
      if (start <= t && t <= start + 0.15) return true;
    }
    return false;
  }

  mark() {
    this.t_mark = this.d.t;
  }

  after(t0) {
    return this.outs.filter((o) => o.t >= t0);
  }

  voiced(t0) {
    return this.after(t0).filter((o) => o.voiced !== null).map((o) => o.voiced);
  }

  events(t0) {
    const out = [];
    for (const o of this.after(t0)) for (const e of o.events) out.push(e);
    return out;
  }
}

const sin = (amp, hz, offset = 0.0) => (t) => offset + amp * Math.sin(2.0 * Math.PI * hz * t);

module.exports = { WARMUP_S, EAR_OPEN, mulberry32, gaussianSource, SyntheticDriver, Run, sin };
