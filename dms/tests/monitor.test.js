'use strict';
/**
 * `dms/monitor.js` (the whole engine) against the reference `DriverMonitor.process_prediction`
 * on the behaviour-evaluation and calibration scenarios.
 */

const test = require('node:test');
const assert = require('node:assert');

const { loadFixture, listMonitorFixtures, Cmp } = require('./helpers');
const { replayMonitorFixture } = require('./replay');
const { DriverMonitor, AlertArbiter, outputToDict } = require('../monitor');
const { FrameFeatures } = require('../features');
const { Event, EventType, Severity } = require('../alerts');
const { createConfig, defaultConfig, validate } = require('../config');
const { anglesToVector } = require('../util');

for (const file of listMonitorFixtures()) {
  test(`monitor parity: ${file.replace(/^monitor_|\.json$/g, '')}`, () => {
    const fx = loadFixture(file);
    const cmp = replayMonitorFixture(fx);
    cmp.assert(assert.ok);
    assert.strictEqual(cmp.eventsMatched, cmp.eventsExpected);
    assert.ok(cmp.maxDiff < 1e-6, `max abs diff ${cmp.maxDiff}`);
  });
}

test('config validation rejects the same configurations as the reference', () => {
  validate(defaultConfig());
  assert.throws(() => validate(createConfig({ attention: { driver_side: 'middle' } })), /driver_side/);
  assert.throws(() => validate(createConfig({ drowsiness: { close_enter: 0.6, close_exit: 0.5 } })), /close_enter/);
  assert.throws(() => validate(createConfig({ front_end: { focal_scale: 0 } })), /focal_scale/);
  assert.throws(() => validate(createConfig({ front_end: { extraction: 'blaze' } })), /extraction/);
  assert.throws(() => validate(createConfig({ calibration: { tau_short_s: 400 } })), /tau_short_s/);
  assert.throws(() => validate(createConfig({ attention: { long_glance_s: 0.2 } })), /long_glance_s/);
  assert.throws(() => validate(createConfig({ attention: { look_down_exit_deg: 20 } })), /look_\*_exit_deg/);
  assert.throws(() => validate(createConfig({ attention: { look_filter_s: 9 } })), /look_filter_s/);
  assert.throws(() => validate(createConfig({ drowsiness: { perclos_long_window_s: 30 } })), /perclos_long_window_s/);
  assert.throws(() => validate(createConfig({ drowsiness: { score_drowsy_exit: 60 } })), /exit thresholds/);
  const dup = defaultConfig();
  dup.zones = dup.zones.concat([dup.zones[0]]);
  assert.throws(() => validate(dup), /unique/);
  const noRoad = defaultConfig();
  noRoad.zones = noRoad.zones.filter((z) => z.kind !== 'road');
  assert.throws(() => validate(noRoad), /road/);
});

test('createConfig deep-merges without touching the defaults', () => {
  const cfg = createConfig({ attention: { long_glance_s: 2.5 }, front_end: { focal_scale: 1.1614 } });
  assert.strictEqual(cfg.attention.long_glance_s, 2.5);
  assert.strictEqual(cfg.attention.long_glance_mirror_s, 4.0);
  assert.strictEqual(cfg.front_end.focal_scale, 1.1614);
  assert.strictEqual(defaultConfig().attention.long_glance_s, 3.0);
});

test('the alert arbiter voices one alert, respects cooldown, ack and the speed gate', () => {
  const cfg = defaultConfig();
  const arb = new AlertArbiter(cfg);
  const long = (t) => new Event(EventType.LONG_GLANCE, t, t - 3, 3.0, 'LAP');
  let [voiced] = arb.update(10.0, [long(10.0)]);
  assert.strictEqual(voiced.type, EventType.LONG_GLANCE);
  [voiced] = arb.update(11.0, [long(11.0)]);              // inside alert_cooldown_s
  assert.strictEqual(voiced, null);
  [voiced] = arb.update(15.0, [long(15.0)]);
  assert.strictEqual(voiced.type, EventType.LONG_GLANCE);
  // a higher-priority alert wins and holds the lower one for ACTIVE_HOLD_S
  const micro = (t) => new Event(EventType.MICROSLEEP, t, t - 1.5, 1.5);
  [voiced] = arb.update(20.0, [long(20.0), micro(20.0)]);
  assert.strictEqual(voiced.type, EventType.MICROSLEEP);
  [voiced] = arb.update(20.5, [long(20.5)]);
  assert.strictEqual(voiced, null);
  // acknowledging silences what was seen, but never the closure family
  const acked = arb.acknowledge(20.6);
  assert.ok(acked.includes(EventType.LONG_GLANCE));
  assert.ok(!acked.includes(EventType.MICROSLEEP));
  [voiced] = arb.update(30.0, [long(30.0)]);
  assert.strictEqual(voiced, null);                        // suppressed for ack_suppress_s
  [voiced] = arb.update(55.0, [long(55.0)]);
  assert.strictEqual(voiced.type, EventType.LONG_GLANCE);
  // the speed gate silences distraction alerts below speed_gate_kmh but not closures
  arb.setVehicleSpeed(5.0);
  [voiced] = arb.update(70.0, [long(70.0)]);
  assert.strictEqual(voiced, null);
  [voiced] = arb.update(70.0, [micro(70.0)]);
  assert.strictEqual(voiced.type, EventType.MICROSLEEP);
  arb.setVehicleSpeed(null);
  // INFO events never voice but do not appear in active_alerts either
  const info = new Event(EventType.OFF_ROAD_GLANCE, 80.0, 79.0, 1.0, 'LAP', { audible: false });
  const [v2, active] = arb.update(80.0, [info]);
  assert.strictEqual(v2, null);
  assert.ok(!active.includes(EventType.OFF_ROAD_GLANCE));
  assert.strictEqual(info.severity, Severity.INFO);
});

test('acknowledge is ignored after ack_abuse_count presses inside the window', () => {
  const arb = new AlertArbiter(defaultConfig());
  const e = (t) => new Event(EventType.LONG_GLANCE, t, t - 3, 3.0, 'LAP');
  for (let k = 0; k < 3; k++) {
    arb.update(k * 40.0, [e(k * 40.0)]);
    assert.ok(arb.acknowledge(k * 40.0 + 0.2).length > 0, `press ${k}`);
  }
  arb.update(120.0, [e(120.0)]);
  assert.deepStrictEqual(arb.acknowledge(120.2), []);     // the 4th press inside 120 s is ignored
});

test('reset, resetRuntime and resetCalibration clear the state', () => {
  const monitor = new DriverMonitor();
  const feat = (t) => FrameFeatures({
    t, face_present: true, ear: 0.32, mar: 0.2, iris_x_in_eye: -0.02, iris_y_in_aperture: -0.01,
    aperture: 0.32, stats: [0.32, -0.01, -0.21, -0.9], eye_visibility: [1, 1], in_frame_fraction: 1,
    eye_center: [0.5, 0.4], iod: 0.12, head_dir: anglesToVector(4, -2), head_yaw: 4, head_pitch: -2, head_roll: 0,
  });
  let out;
  for (let k = 0; k < 30 * 40; k++) {
    out = monitor.processPrediction(k / 30, anglesToVector(5, -3), null, feat(k / 30));
  }
  assert.strictEqual(out.confidence, 'PROVISIONAL');
  assert.ok(out.admitted_s > 30.0);
  monitor.resetCalibration();
  out = monitor.processPrediction(40.0, anglesToVector(5, -3), null, feat(40.0));
  assert.strictEqual(out.confidence, 'NONE');
  monitor.reset();
  assert.strictEqual(monitor.drowsiness.t_prev, null);
  assert.strictEqual(monitor.attention.t_last, null);
  assert.strictEqual(monitor.arbiter.last_voiced.size, 0);
});

test('outputToDict nulls non-finite floats and keeps the event rounding', () => {
  const monitor = new DriverMonitor();
  const out = monitor.processPrediction(0.0, null, null, FrameFeatures({ t: 0.0, face_present: false }));
  const d = outputToDict(out);
  assert.strictEqual(d.gaze, null);
  assert.strictEqual(d.gaze_yaw, null);
  assert.strictEqual(d.head_dev_deg, null);
  assert.strictEqual(d.confidence, 'NONE');
  assert.deepStrictEqual(d.events, []);
  assert.strictEqual(d.voiced, null);
  assert.ok(Array.isArray(d.active_alerts));
});

test('process() runs the landmark front end and injects the network', () => {
  const fx = loadFixture('gaze_inputs_cases');
  const c = fx.cases[0];
  const monitor = new DriverMonitor(createConfig({ front_end: { focal_scale: c.focal_scale } }));
  let seen = null;
  const predict = (cloud, context, validity) => {
    seen = { cloud, context, validity };
    return { gaze: [0.0, 0.0, 1.0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  };
  const frame = { t: 0.0, landmarks: c.landmarks, width: c.width, height: c.height, face_present: true };
  const out = monitor.process(frame, predict);
  assert.ok(seen !== null);
  assert.strictEqual(seen.cloud.length, 478 * 3);
  assert.strictEqual(seen.context.length, 7);
  assert.strictEqual(seen.validity.length, 478);
  assert.ok(seen.cloud instanceof Float32Array);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(seen.context[i] - c.context3[i]) < 1e-6, `context[${i}]`);
  }
  assert.strictEqual(out.face_present, true);
  assert.ok(Number.isFinite(out.head_yaw));
  // prepareInputs + finishFrame is the async path and must agree with process()
  const monitor2 = new DriverMonitor(createConfig({ front_end: { focal_scale: c.focal_scale } }));
  const inputs = monitor2.prepareInputs(frame);
  const out2 = monitor2.finishFrame(frame, inputs, predict(inputs.cloud, inputs.context, inputs.validity));
  assert.strictEqual(out2.zone, out.zone);
  assert.strictEqual(out2.openness, out.openness);
  assert.strictEqual(out2.head_yaw, out.head_yaw);
  // no face -> empty features, no throw
  const empty = monitor2.process({ t: 1.0, landmarks: null, width: c.width, height: c.height, face_present: false }, predict);
  assert.strictEqual(empty.face_present, false);
});
