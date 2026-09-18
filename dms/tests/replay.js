'use strict';
/** Replays a monitor / drowsiness fixture through the JS port and scores the parity. */

const { DriverMonitor, outputToDict } = require('../monitor');
const { DrowsinessTracker } = require('../drowsiness');
const { FrameFeatures } = require('../features');
const { defaultConfig } = require('../config');
const { decodeFrames, loadFixture, Cmp } = require('./helpers');

const FEAT_FIELDS = ['ear_right', 'ear_left', 'ear', 'ear_near', 'mar', 'iris_x_in_eye',
                     'iris_y_in_aperture', 'aperture', 'in_frame_fraction', 'iod',
                     'head_yaw', 'head_pitch', 'head_roll'];

function n(v) {
  return v === null || v === undefined ? NaN : v;
}

/** Rebuild the FrameFeatures the reference saw from the decoded input columns. */
function featAt(cols, i) {
  const f = FrameFeatures({ t: n(cols.t[i]), face_present: Boolean(cols.face_present[i]) });
  for (const name of FEAT_FIELDS) f[name] = n(cols[name][i]);
  f.stats = [n(cols.stats0[i]), n(cols.stats1[i]), n(cols.stats2[i]), n(cols.stats3[i])];
  f.eye_visibility = [n(cols.eye_vis0[i]), n(cols.eye_vis1[i])];
  f.eye_center = [n(cols.eye_center0[i]), n(cols.eye_center1[i])];
  const hx = cols.head_dir_x[i];
  f.head_dir = hx === null || hx === undefined ? null
    : [cols.head_dir_x[i], cols.head_dir_y[i], cols.head_dir_z[i]];
  return f;
}

const OUT_SCALARS = ['gaze_yaw', 'gaze_pitch', 'rel_left', 'rel_up', 'reference_yaw', 'reference_pitch',
                     'admitted_s', 'concentration', 'calib_weight', 'head_dev_deg',
                     'buffer_s', 'offroad_30s', 'glance_s', 'prc', 'openness', 'perclos', 'blink_rate_per_min',
                     'blink_mean_duration_s', 'closure_s', 'drowsiness_score', 'exposure_60s', 'road_share_60s',
                     'head_pitch_dev', 'perclos_long'];
const OUT_EXACT = ['zone', 'zone_kind', 'confidence', 'yawn_count', 'yawn_active',
                   'drowsiness_level', 'glance_class', 'offroad_glances_60s', 'eyes_readable'];
// `t`, `head_yaw`, `head_pitch` and `face_present` are copied straight from the frame features,
// so the fixture stores them once (as inputs) and the replay asserts the copy.
const OUT_FROM_INPUT = ['t', 'head_yaw', 'head_pitch'];

/** Decode the input columns, prepending the shared warm-up prefix when the fixture has one. */
function decodeInputs(fx) {
  const own = decodeFrames(fx.inputs);
  if (!fx.inputs_prefix) return own;
  const prefix = decodeFrames(loadFixture(fx.inputs_prefix).columns);
  const out = {};
  for (const name of Object.keys(own)) {
    const head = prefix[name];
    if (head === undefined) throw new Error(`warm-up prefix has no column ${name}`);
    out[name] = head.concat(own[name]);
  }
  return out;
}

function replayMonitorFixture(fx, tol = 1e-6) {
  const cmp = new Cmp(fx.scenario, tol);
  const inputs = decodeInputs(fx);
  const outputs = decodeFrames(fx.outputs);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const monitor = new DriverMonitor(defaultConfig());
  if (fx.speed_kmh !== null && fx.speed_kmh !== undefined) monitor.setVehicleSpeed(fx.speed_kmh);
  const events = [];
  const voiced = [];
  const outFrames = fx.output_frames;
  let row = 0;
  for (let i = 0; i < fx.frames; i++) {
    const feat = featAt(inputs, i);
    const gx = inputs.gaze_x[i];
    const gaze = gx === null || gx === undefined ? null : [inputs.gaze_x[i], inputs.gaze_y[i], inputs.gaze_z[i]];
    const out = monitor.processPrediction(n(inputs.t[i]), gaze, gaze === null ? null : identity, feat);
    for (const e of out.events) events.push(Object.assign({ i }, e.toDict()));
    if (out.voiced !== null) voiced.push(Object.assign({ i }, out.voiced.toDict()));
    if (row < outFrames.length && outFrames[row] === i) {
      const d = outputToDict(out);
      for (const name of OUT_SCALARS) cmp.num(`${name}@${i}`, d[name], outputs[name][row]);
      for (const name of OUT_EXACT) cmp.exact(`${name}@${i}`, d[name], outputs[name][row]);
      for (const name of OUT_FROM_INPUT) cmp.num(`${name}@${i}`, d[name], inputs[name][i], 0);
      cmp.exact(`face_present@${i}`, d.face_present, Boolean(inputs.face_present[i]));
      const gazeOut = d.gaze;
      for (let k = 0; k < 3; k++) {
        const axis = 'xyz'[k];
        cmp.num(`gaze_${axis}@${i}`, gazeOut === null ? null : gazeOut[k], outputs[`gaze_${axis}`][row]);
      }
      cmp.exact(`q_face_present@${i}`, d.quality.face_present, outputs.q_face_present[row]);
      cmp.num(`q_in_frame_fraction@${i}`, d.quality.in_frame_fraction, outputs.q_in_frame_fraction[row]);
      cmp.exact(`q_eyes_open@${i}`, d.quality.eyes_open, outputs.q_eyes_open[row]);
      cmp.num(`q_vis0@${i}`, d.quality.eye_visibility[0], outputs.q_vis0[row]);
      cmp.num(`q_vis1@${i}`, d.quality.eye_visibility[1], outputs.q_vis1[row]);
      cmp.num(`q_head_speed@${i}`, d.quality.head_speed_deg_s, outputs.q_head_speed[row]);
      cmp.exact(`q_usable@${i}`, d.quality.usable, outputs.q_usable[row]);
      const expectedActive = outputs.active_alerts[row];
      cmp.exact(`active_alerts@${i}`, JSON.stringify(d.active_alerts), JSON.stringify(expectedActive));
      row += 1;
    }
  }
  cmp.exact('input_frames', Object.values(inputs)[0].length, fx.frames);
  cmp.exact('output_rows', row, outFrames.length);
  cmp.exact('event_count', events.length, fx.events.length);
  for (let k = 0; k < Math.min(events.length, fx.events.length); k++) {
    cmp.event(`event[${k}]`, events[k], fx.events[k]);
  }
  cmp.exact('voiced_count', voiced.length, fx.voiced.length);
  for (let k = 0; k < Math.min(voiced.length, fx.voiced.length); k++) {
    cmp.event(`voiced[${k}]`, voiced[k], fx.voiced[k]);
  }
  cmp.frames = fx.frames;
  cmp.comparedFrames = outFrames.length;
  return cmp;
}

const DSTATE_SCALARS = ['openness', 'ear_open_baseline', 'ear_closed_baseline', 'closure_duration_s',
                        'blink_rate_per_min', 'blink_mean_duration_s', 'perclos', 'perclos_long', 'score'];
const DSTATE_EXACT = ['eyes_open', 'closure_active', 'long_blink_count', 'perclos_valid', 'perclos_long_valid',
                      'yawn_active', 'yawn_count_window', 'nod_count_window', 'level'];

function replayDrowsinessFixture(fx, tol = 1e-6) {
  const cmp = new Cmp(fx.stream, tol);
  const inputs = decodeFrames(fx.inputs);
  const args = decodeFrames(fx.args);
  const outputs = decodeFrames(fx.outputs);
  const tracker = new DrowsinessTracker(defaultConfig());
  const events = [];
  for (let i = 0; i < fx.frames; i++) {
    const feat = featAt(inputs, i);
    const turn = args.head_turn_deg[i];
    const pitchDev = args.head_pitch_dev[i];
    const st = tracker.update(n(inputs.t[i]), feat, turn === null ? null : turn, pitchDev === null ? null : pitchDev);
    for (const e of st.events) events.push(Object.assign({ i }, e.toDict()));
    for (const name of DSTATE_SCALARS) cmp.num(`${name}@${i}`, st[name], outputs[name][i]);
    for (const name of DSTATE_EXACT) cmp.exact(`${name}@${i}`, st[name], outputs[name][i]);
  }
  cmp.exact('event_count', events.length, fx.events.length);
  for (let k = 0; k < Math.min(events.length, fx.events.length); k++) {
    cmp.event(`event[${k}]`, events[k], fx.events[k]);
  }
  cmp.frames = fx.frames;
  cmp.comparedFrames = fx.frames;
  return cmp;
}

module.exports = { featAt, decodeInputs, replayMonitorFixture, replayDrowsinessFixture, OUT_SCALARS, OUT_EXACT };
