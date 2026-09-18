'use strict';
/**
 * `DriverMonitor`: one landmark frame in, the full monitoring state out (`dms/monitor.py`).
 *
 * Pipeline per frame: landmarks -> cloud / context / validity / subject statistic -> gaze network
 * -> causal median of the gaze angles -> landmark features -> drowsiness -> gaze quality ->
 * forward-reference calibration -> attention rules -> face-presence state machine -> alert
 * arbitration.  `processPrediction` enters after the network (replays, parity tests).
 *
 * The network is INJECTED.  Three ways in:
 *   monitor.process(frame, predictFn)        - synchronous predictFn(cloud, context, validity)
 *   const inp = monitor.prepareInputs(frame) - then await your async runtime, then
 *   monitor.finishFrame(frame, inp, prediction)
 *   monitor.processPrediction(t, gaze, rotation, feat)  - features computed elsewhere
 */

const { Event, EventType, PRIORITY, Severity } = require('./alerts');
const { AttentionRules } = require('./attention');
const { ForwardReference } = require('./calibration');
const { validate } = require('./config');
const { DrowsinessTracker } = require('./drowsiness');
const { FrameFeatures, computeFeatures } = require('./features');
const { SubjectStatisticTracker, cameraContext, landmarkValidity, weak3dCloud } = require('./gaze_inputs');
const { Deque, anglesToVector, angularDistanceDeg, vectorToAngles } = require('./util');

const DROWSINESS_TYPES = new Set([EventType.DROWSY, EventType.SEVERE_DROWSY, EventType.FREQUENT_YAWNING, EventType.SLOW_BLINKS]);
const FAST_REPEAT_TYPES = new Set([EventType.MICROSLEEP, EventType.SLEEP, EventType.EYES_CLOSED]);

/** `models/gaze_direct.meta.json` -> subject_stats.training_mean of the shipped bundle. */
const TRAINING_MEAN = [0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419];
const EYE_GATE = [0.45, 0.65];

function GazeQuality(fields = {}) {
  return Object.assign({
    face_present: false,
    in_frame_fraction: 0.0,
    eyes_open: false,
    eye_visibility: [1.0, 1.0],
    head_speed_deg_s: 0.0,
    usable: false,
  }, fields);
}

function MonitorOutput(t, facePresent) {
  return {
    t,
    face_present: facePresent,
    gaze: null,
    gaze_yaw: NaN,
    gaze_pitch: NaN,
    rel_left: NaN,
    rel_up: NaN,
    zone: 'UNKNOWN',
    zone_kind: 'unknown',
    reference_yaw: NaN,
    reference_pitch: NaN,
    confidence: 'NONE',
    admitted_s: 0.0,
    concentration: 0.0,
    calib_weight: 0.0,
    head_yaw: NaN,
    head_pitch: NaN,
    head_dev_deg: NaN,
    quality: {},
    buffer_s: 0.0,
    offroad_30s: 0.0,
    glance_s: 0.0,
    prc: null,
    openness: 1.0,
    perclos: null,
    blink_rate_per_min: 0.0,
    blink_mean_duration_s: 0.0,
    yawn_count: 0,
    yawn_active: false,
    closure_s: 0.0,
    drowsiness_score: 0.0,
    drowsiness_level: 'ALERT',
    glance_class: 'none',
    exposure_60s: 0.0,
    offroad_glances_60s: 0,
    road_share_60s: null,
    head_pitch_dev: NaN,
    perclos_long: null,
    eyes_readable: true,
    events: [],
    voiced: null,
    active_alerts: [],
    latency_ms: 0.0,
  };
}

/** The reference `MonitorOutput.to_dict()`: non-finite top-level floats become null. */
function outputToDict(out) {
  const d = {};
  for (const k of Object.keys(out)) {
    if (k === 'events' || k === 'voiced') continue;
    d[k] = out[k];
  }
  d.events = out.events.map((e) => e.toDict());
  d.voiced = out.voiced !== null ? out.voiced.toDict() : null;
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (typeof v === 'number' && !Number.isFinite(v)) d[k] = null;
  }
  return d;
}

/**
 * One voiced alert per frame at most: the highest-priority audible event that is not in its
 * per-type cooldown.  `active` lists the types heard from in the last `ACTIVE_HOLD_S` seconds.
 */
class AlertArbiter {
  constructor(config) {
    this.cfg = config.alerts;
    this.reset();
  }

  reset() {
    this.last_voiced = new Map();
    this.last_seen = new Map();
    this.suppressed_until = new Map();
    this.vehicle_speed_kmh = null;
    this.ack_times = [];
    this.last_voiced_any = null;   // [priority, t] of the last voiced alert
  }

  /** The driver acknowledged the current alert(s): silence them for `ack_suppress_s`. */
  acknowledge(t) {
    this.ack_times = this.ack_times.filter((x) => t - x <= this.cfg.ack_abuse_window_s);
    if (this.ack_times.length >= this.cfg.ack_abuse_count) return [];
    this.ack_times.push(t);
    const acked = [];
    for (const [k, ts] of this.last_seen) {
      if (t - ts <= AlertArbiter.ACTIVE_HOLD_S && !FAST_REPEAT_TYPES.has(k) && k !== EventType.DRIVER_NOT_VISIBLE) {
        acked.push(k);
      }
    }
    for (const k of acked) this.suppressed_until.set(k, t + this.cfg.ack_suppress_s);
    return acked.slice();
  }

  setVehicleSpeed(kmh) {
    this.vehicle_speed_kmh = kmh === null || kmh === undefined ? null : kmh;
  }

  /** True when the vehicle is known to be (almost) stationary and this alert should stay silent. */
  speedGated(eventType) {
    if (this.vehicle_speed_kmh === null || this.vehicle_speed_kmh >= this.cfg.speed_gate_kmh) return false;
    return !(eventType === EventType.DRIVER_NOT_VISIBLE || eventType === EventType.PROLONGED_CLOSURE
             || eventType === EventType.MICROSLEEP || eventType === EventType.SLEEP || eventType === EventType.EYES_CLOSED);
  }

  cooldown(eventType) {
    if (FAST_REPEAT_TYPES.has(eventType)) return AlertArbiter.CRITICAL_REPEAT_S;
    if (DROWSINESS_TYPES.has(eventType)) return this.cfg.drowsiness_cooldown_s;
    return this.cfg.alert_cooldown_s;
  }

  update(t, events) {
    let voiced = null;
    const ordered = events.slice().sort((a, b) => -a.priority - -b.priority);
    for (const e of ordered) {
      if (e.severity === Severity.INFO) continue;
      this.last_seen.set(e.type, t);
      if (e.extra.audible === false) continue;
      if (voiced === null) {
        const last = this.last_voiced.has(e.type) ? this.last_voiced.get(e.type) : null;
        const suppressed = this.suppressed_until.has(e.type) ? this.suppressed_until.get(e.type) : -1.0;
        if (t < suppressed || this.speedGated(e.type)) continue;
        if (this.last_voiced_any !== null && e.priority < this.last_voiced_any[0]
            && t - this.last_voiced_any[1] < AlertArbiter.ACTIVE_HOLD_S) {
          continue;
        }
        if (last === null || t - last >= this.cooldown(e.type)) {
          voiced = e;
          this.last_voiced.set(e.type, t);
          this.last_voiced_any = [e.priority, t];
        }
      }
    }
    const active = [];
    for (const [k, ts] of this.last_seen) if (t - ts <= AlertArbiter.ACTIVE_HOLD_S) active.push(k);
    active.sort((a, b) => -(PRIORITY[a] || 0) - -(PRIORITY[b] || 0));
    return [voiced, active];
  }
}

AlertArbiter.ACTIVE_HOLD_S = 3.0;
AlertArbiter.CRITICAL_REPEAT_S = 1.5;

class DriverMonitor {
  /**
   * @param {object} config           a `config.createConfig()` object (defaults when omitted)
   * @param {object} options
   *   `trainingMean` (4) and `eyeGate` [low, high] of the deployed bundle.
   */
  constructor(config = null, options = {}) {
    const { defaultConfig } = require('./config');
    this.cfg = config || defaultConfig();
    validate(this.cfg);
    this.training_mean = Float64Array.from(options.trainingMean || TRAINING_MEAN);
    this.eye_gate = options.eyeGate || EYE_GATE;
    const fe = this.cfg.front_end;
    this.stats = new SubjectStatisticTracker(this.training_mean, {
      warmup: fe.stat_warmup_frames,
      windowS: fe.stat_window_s,
      lo: fe.stat_hist_lo,
      hi: fe.stat_hist_hi,
      binWidth: fe.stat_hist_bin,
    });
    this.calibration = new ForwardReference(this.cfg);
    this.attention = new AttentionRules(this.cfg);
    this.drowsiness = new DrowsinessTracker(this.cfg);
    this.arbiter = new AlertArbiter(this.cfg);
    this.resetRuntime();
  }

  resetRuntime() {
    this.t_prev_step = null;
    this.dt_typical = null;
    this.t_last = null;
    this.last_face_t = null;
    this.absent_last_emit = null;
    this.absent_voiced = false;
    this.prev_head_dir = null;
    this.prev_head_t = null;
    this.prev_head_dev = null;
    this.prev_head_pitch_dev = null;
    this.unreadable_since = null;
    this.unreadable_emitted = false;
    this.gaze_window = new Deque();
  }

  /** Full reset (manual re-calibration): every tracker starts over. */
  reset() {
    this.stats.reset();
    this.calibration.reset();
    this.attention.reset();
    this.drowsiness.reset();
    this.arbiter.reset();
    this.resetRuntime();
  }

  // ------------------------------------------------------------------ entry points
  /** Forget the forward reference only. */
  resetCalibration() {
    this.calibration.reset();
  }

  /** Driver acknowledged the active alert(s): silence them for `ack_suppress_s`. */
  acknowledge(t) {
    return this.arbiter.acknowledge(t);
  }

  /** Optional vehicle speed (CAN / GPS); null = unknown, rules stay fully active. */
  setVehicleSpeed(kmh) {
    this.arbiter.setVehicleSpeed(kmh);
  }

  /**
   * Landmarks -> network inputs.  `frame`: `{t, landmarks, width, height, face_present}`.
   * Returns null when there is no usable face; otherwise
   * `{cloud (Float32Array 478*3), cloud64 (Float64Array), context (Float32Array 7),
   *   context3, validity (Float32Array 478), landmarks}`.
   */
  prepareInputs(frame) {
    if (!frame.face_present || frame.landmarks === null || frame.landmarks === undefined) return null;
    let cloud64;
    let context3;
    let validity;
    try {
      cloud64 = weak3dCloud(frame.landmarks, frame.width, frame.height);
      context3 = cameraContext(frame.landmarks, frame.width, frame.height, this.cfg.front_end.focal_scale);
      validity = landmarkValidity(frame.landmarks);
    } catch (err) {
      return null;
    }
    const stats = this.stats.current();
    const context = new Float32Array(7);
    context[0] = context3[0];
    context[1] = context3[1];
    context[2] = context3[2];
    for (let k = 0; k < 4; k++) context[3 + k] = stats[k];
    return {
      // `new Float32Array(src)` is the engine's element-wise convert (`.from` walks the iterator
      // protocol); identical float64 -> float32 rounding, much cheaper on the frame path.
      cloud: new Float32Array(cloud64),
      cloud64,
      context,
      context3,
      validity,
      landmarks: frame.landmarks,
    };
  }

  /**
   * Second half of `process`: features from the prepared inputs + the network's prediction
   * (`{gaze, rotation}` or null), then the rule step.
   */
  finishFrame(frame, inputs, prediction) {
    const t = frame.t;
    if (inputs === null) return this._step(t, null, null, FrameFeatures({ t, face_present: false }));
    const gaze = prediction && prediction.gaze ? Array.from(prediction.gaze) : null;
    const rotation = prediction && prediction.rotation ? prediction.rotation : null;
    const feat = computeFeatures(t, inputs.landmarks, frame.width, frame.height, inputs.cloud64,
                                 inputs.validity, rotation, this.eye_gate);
    return this._step(t, gaze, rotation, feat);
  }

  /**
   * One frame end to end with a SYNCHRONOUS network:
   * `predictFn(cloud, context, validity) -> {gaze: Float32Array(3), rotation: Float32Array(9)}`.
   * An async runtime uses `prepareInputs` + `finishFrame` instead.
   */
  process(frame, predictFn) {
    const started = Date.now();
    const inputs = this.prepareInputs(frame);
    let prediction = null;
    if (inputs !== null && predictFn) prediction = predictFn(inputs.cloud, inputs.context, inputs.validity);
    const out = this.finishFrame(frame, inputs, prediction);
    out.latency_ms = Date.now() - started;
    return out;
  }

  /** Enter after the network: `feat` is a FrameFeatures (face_present false when no face). */
  processPrediction(t, gazeVec, rotation, feat) {
    const started = Date.now();
    const out = this._step(t, gazeVec === null || gazeVec === undefined ? null : Array.from(gazeVec), rotation, feat);
    out.latency_ms = Date.now() - started;
    return out;
  }

  // ------------------------------------------------------------------ the step
  _filteredGaze(t, gaze) {
    const window = this.cfg.front_end.gaze_median_window_s;
    if (gaze === null) {
      this.gaze_window.clear();
      return null;
    }
    const [yaw, pitch] = vectorToAngles(gaze);
    this.gaze_window.push([t, yaw, pitch]);
    while (this.gaze_window.length && this.gaze_window.first()[0] < t - window) this.gaze_window.shift();
    if (this.gaze_window.length < 2) return Array.from(gaze);
    const items = this.gaze_window.toArray();
    const ys = items.map((v) => v[1]).sort((a, b) => a - b);
    const ps = items.map((v) => v[2]).sort((a, b) => a - b);
    const n = ys.length;
    const my = n % 2 ? ys[(n - (n % 2)) / 2] : 0.5 * (ys[n / 2 - 1] + ys[n / 2]);
    const mp = n % 2 ? ps[(n - (n % 2)) / 2] : 0.5 * (ps[n / 2 - 1] + ps[n / 2]);
    return anglesToVector(my, mp);
  }

  _step(t, gaze, rotation, feat) {
    const fe = this.cfg.front_end;
    if (this.t_prev_step !== null && t < this.t_prev_step - 1.0) this.reset();
    const rawDt = this.t_prev_step === null ? 0.0 : Math.max(0.0, t - this.t_prev_step);
    if (rawDt > 0.0 && (this.dt_typical === null || rawDt <= Math.max(1.0, fe.dt_gap_factor * this.dt_typical))) {
      this.dt_typical = this.dt_typical === null ? rawDt : 0.9 * this.dt_typical + 0.1 * rawDt;
    }
    this.t_prev_step = t;
    const effDt = Math.max(fe.max_dt_s, fe.dt_clip_period_factor * (this.dt_typical === null ? 0.0 : this.dt_typical));
    this.calibration.max_dt = effDt;
    this.attention.max_dt = effDt;
    this.drowsiness.max_dt = effDt;
    const cfg = this.cfg;
    const events = [];
    const facePresent = Boolean(feat && feat.face_present);
    const out = MonitorOutput(t, facePresent);
    this.t_last = t;

    const headDir = feat && feat.head_dir !== undefined ? feat.head_dir : null;
    const preDev = facePresent ? this.calibration.headDeviation(headDir) : null;
    const dstate = this.drowsiness.update(t, feat, preDev === null ? null : preDev[0], preDev === null ? null : preDev[1]);
    for (const e of dstate.events || []) events.push(e);
    const eyesOpen = facePresent ? Boolean(dstate.eyes_open) : false;

    let headSpeed = 0.0;
    if (headDir !== null && this.prev_head_dir !== null && this.prev_head_t !== null && t - this.prev_head_t > 1e-3) {
      headSpeed = angularDistanceDeg(headDir, this.prev_head_dir) / (t - this.prev_head_t);
    }
    if (headDir !== null) {
      this.prev_head_dir = [headDir[0], headDir[1], headDir[2]];
      this.prev_head_t = t;
    } else if (!facePresent) {
      this.prev_head_dir = null;
    }

    const filtered = this._filteredGaze(t, facePresent ? gaze : null);
    const inFrame = facePresent ? (feat.in_frame_fraction !== undefined ? feat.in_frame_fraction : 0.0) : 0.0;
    const eyeVis = feat && feat.eye_visibility !== undefined ? feat.eye_visibility : [1.0, 1.0];
    const quality = GazeQuality({
      face_present: facePresent,
      in_frame_fraction: inFrame,
      eyes_open: eyesOpen,
      eye_visibility: [eyeVis[0], eyeVis[1]],
      head_speed_deg_s: headSpeed,
      usable: Boolean(facePresent && filtered !== null && inFrame >= cfg.front_end.min_in_frame_fraction && eyesOpen),
    });

    const stats = feat && feat.stats !== undefined ? feat.stats : null;
    if (facePresent && eyesOpen && stats !== null && stats !== undefined
        && Number.isFinite(stats[0]) && Number.isFinite(stats[1]) && Number.isFinite(stats[2]) && Number.isFinite(stats[3])) {
      this.stats.push(stats, t);
    }

    const rstate = this.calibration.update(t, quality.usable ? filtered : null, quality, feat,
                                           this.arbiter.vehicle_speed_kmh);
    for (const e of rstate.events) {
      events.push(e);
      if (e.type === EventType.DRIVER_CHANGE || e.type === EventType.CAMERA_MOVED) {
        this.stats.reset();
        this.drowsiness.reset();
        this.attention.reset();
      }
    }

    let rel = null;
    if (quality.usable && rstate.reference !== null && filtered !== null) {
      rel = this.calibration.relativeAngles(filtered);
    }
    const headDev = facePresent ? this.calibration.headDeviation(headDir) : null;
    this.prev_head_dev = headDev !== null ? headDev[0] : null;
    this.prev_head_pitch_dev = headDev !== null ? headDev[1] : null;

    const astate = this.attention.update(
      t, rel, quality.usable, headDev === null ? null : headDev[0], headDev === null ? null : headDev[1],
      rstate.confidence, this.arbiter.vehicle_speed_kmh);
    for (const e of astate.events) events.push(e);

    // face-presence state machine
    if (facePresent) {
      this.last_face_t = t;
      this.absent_last_emit = null;
      this.absent_voiced = false;
    } else if (this.last_face_t !== null) {
      const absent = t - this.last_face_t;
      const due = (this.absent_last_emit === null && absent >= cfg.alerts.driver_absent_s)
        || (this.absent_last_emit !== null && !this.absent_voiced && absent >= cfg.alerts.driver_absent_alert_s)
        || (this.absent_voiced && t - this.absent_last_emit >= cfg.alerts.driver_absent_repeat_s);
      if (due) {
        this.absent_last_emit = t;
        const audible = absent >= cfg.alerts.driver_absent_alert_s;
        this.absent_voiced = this.absent_voiced || audible;
        events.push(new Event(EventType.DRIVER_NOT_VISIBLE, t, this.last_face_t, absent, '', { audible }));
      }
    }

    let eyesReadable = true;
    if (facePresent) {
      const earNear = feat.ear_near === undefined ? NaN : feat.ear_near;
      const ear = feat.ear === undefined ? NaN : feat.ear;
      eyesReadable = Number.isFinite(earNear) || Number.isFinite(ear);
    }
    if (facePresent && !eyesReadable) {
      if (this.unreadable_since === null) this.unreadable_since = t;
      if (!this.unreadable_emitted && t - this.unreadable_since >= cfg.alerts.eyes_unreadable_s) {
        this.unreadable_emitted = true;
        events.push(new Event(EventType.EYES_UNREADABLE, t, this.unreadable_since, t - this.unreadable_since));
      }
    } else {
      this.unreadable_since = null;
      this.unreadable_emitted = false;
    }

    if (cfg.alerts.microsleep_needs_calibration && rstate.confidence === 'NONE') {
      for (const e of events) if (e.type === EventType.MICROSLEEP) e.extra.audible = false;
    }
    const [voiced, active] = this.arbiter.update(t, events);

    // assemble
    if (filtered !== null) {
      out.gaze = [filtered[0], filtered[1], filtered[2]];
      const [gy, gp] = vectorToAngles(filtered);
      out.gaze_yaw = gy;
      out.gaze_pitch = gp;
    }
    if (rel !== null) {
      out.rel_left = astate.left_deg;
      out.rel_up = astate.up_deg;
    }
    out.zone = astate.zone;
    out.zone_kind = astate.zone_kind;
    out.reference_yaw = rstate.yaw;
    out.reference_pitch = rstate.pitch;
    out.confidence = rstate.confidence;
    out.admitted_s = rstate.admitted_s;
    out.concentration = rstate.concentration;
    out.calib_weight = rstate.weight;
    out.head_yaw = feat && feat.head_yaw !== undefined ? feat.head_yaw : NaN;
    out.head_pitch = feat && feat.head_pitch !== undefined ? feat.head_pitch : NaN;
    out.head_dev_deg = headDev !== null ? headDev[0] : NaN;
    out.quality = quality;
    out.buffer_s = astate.buffer_s;
    out.offroad_30s = astate.offroad_30s;
    out.glance_s = astate.glance_s;
    out.prc = astate.prc;
    out.openness = dstate.openness !== undefined ? dstate.openness : 1.0;
    out.perclos = dstate.perclos !== undefined ? dstate.perclos : null;
    out.blink_rate_per_min = dstate.blink_rate_per_min || 0.0;
    out.blink_mean_duration_s = dstate.blink_mean_duration_s || 0.0;
    out.yawn_count = dstate.yawn_count_window || 0;
    out.yawn_active = Boolean(dstate.yawn_active);
    out.closure_s = dstate.closure_duration_s || 0.0;
    out.drowsiness_score = dstate.score || 0.0;
    out.drowsiness_level = String(dstate.level || 'ALERT');
    out.glance_class = String(astate.glance_class || 'none');
    out.exposure_60s = astate.exposure_60s || 0.0;
    out.offroad_glances_60s = astate.offroad_glances_60s || 0;
    out.road_share_60s = astate.road_share_60s !== undefined ? astate.road_share_60s : null;
    out.head_pitch_dev = headDev !== null ? headDev[1] : NaN;
    out.perclos_long = dstate.perclos_long !== undefined ? dstate.perclos_long : null;
    out.eyes_readable = eyesReadable;
    out.events = events;
    out.voiced = voiced;
    out.active_alerts = active;
    return out;
  }
}

module.exports = {
  GazeQuality,
  MonitorOutput,
  outputToDict,
  AlertArbiter,
  DriverMonitor,
  DROWSINESS_TYPES,
  FAST_REPEAT_TYPES,
  TRAINING_MEAN,
  EYE_GATE,
};
