'use strict';
/**
 * The PHONE engine options of `docs/dms/DETECTION_DESIGN.md` §5, §6 and §7a.
 *
 * Each option is a config field whose DEFAULT reproduces the Python reference (so every parity
 * fixture still passes unchanged); these tests prove the non-default behaviour on synthetic
 * streams, and each one also checks that the default is inert.
 */

const test = require('node:test');
const assert = require('node:assert');

const { AttentionRules } = require('../attention');
const { Event, EventType, Severity } = require('../alerts');
const { createConfig, defaultConfig } = require('../config');
const { createAppConfig } = require('../app_config');
const { DrowsinessTracker } = require('../drowsiness');
const { FrameFeatures } = require('../features');
const { AlertArbiter, DriverMonitor } = require('../monitor');
const { anglesToVector } = require('../util');
const { SyntheticDriver } = require('./synthetic');

// ------------------------------------------------------------------ helpers
/** Feed a fresh monitor `seconds` of the synthetic driver; returns the outputs. */
function drive(monitor, driver, seconds, kw = {}) {
  const outs = [];
  const n = Math.round(seconds * driver.fps);
  for (let i = 0; i < n; i++) {
    const f = driver.frame(kw);
    outs.push(monitor.processPrediction(f.t, f.gaze, f.rotation, f.feat));
  }
  return outs;
}

/** A drowsiness feature frame with a given EAR (eyes otherwise ideal, head at rest). */
function earFrame(t, ear, mar = 0.2, headPitch = 0.0) {
  return FrameFeatures({
    t, face_present: true, ear_right: ear, ear_left: ear, ear, ear_near: ear, mar,
    iris_x_in_eye: 0.0, iris_y_in_aperture: 0.0, aperture: 0.3, stats: [0.3, 0.0, -0.2, -0.9],
    eye_visibility: [1.0, 1.0], in_frame_fraction: 1.0, eye_center: [0.5, 0.4], iod: 0.12,
    head_dir: anglesToVector(0.0, headPitch), head_yaw: 0.0, head_pitch: headPitch, head_roll: 0.0,
  });
}

const EAR_OPEN = 0.32;
const EAR_CLOSED = 0.08;

/** Raised-cosine closure depth in [0, 1] (the `synth_streams.py` blink profile). */
function dip(u) {
  return u >= 0.0 && u <= 1.0 ? 0.5 * (1.0 - Math.cos(2.0 * Math.PI * u)) : 0.0;
}

/** A stream of `duration` seconds at `fps` with closures of `closureS` every `periodS`. */
function closureStream(fps, duration, periodS, closureS, firstS = 5.0) {
  const out = [];
  for (let k = 0; k < Math.round(duration * fps); k++) {
    const t = k / fps;
    let closed = 0.0;
    for (let s = firstS; s < duration; s += periodS) {
      if (t >= s && t <= s + closureS) closed = Math.max(closed, dip((t - s) / closureS));
    }
    out.push(earFrame(t, EAR_OPEN - (EAR_OPEN - EAR_CLOSED) * closed));
  }
  return out;
}

function runTracker(cfg, stream) {
  const tracker = new DrowsinessTracker(cfg);
  const states = [];
  const events = [];
  for (const f of stream) {
    const st = tracker.update(f.t, f, null, null);
    states.push(st);
    for (const e of st.events) events.push(e);
  }
  return { tracker, states, events };
}

// ------------------------------------------------------------------ (a) calibration.stationary_weight
test('(a) stationary_weight down-weights admission below the speed gate only', () => {
  const run = (cfg, speed) => {
    const monitor = new DriverMonitor(cfg);
    monitor.setVehicleSpeed(speed);
    const outs = drive(monitor, new SyntheticDriver({ fps: 15.0, seed: 3 }), 60.0);
    return outs[outs.length - 1];
  };
  const reference = defaultConfig();
  const phone = createConfig({ calibration: { stationary_weight: 0.25 } });
  assert.strictEqual(reference.calibration.stationary_weight, 1.0, 'the default must be the reference');

  // stationary (0 km/h, below alerts.speed_gate_kmh = 10)
  const refStopped = run(reference, 0.0);
  const phoneStopped = run(phone, 0.0);
  assert.ok(refStopped.admitted_s > 30.0, `reference admitted ${refStopped.admitted_s}`);
  const ratio = refStopped.admitted_s / phoneStopped.admitted_s;
  assert.ok(ratio > 3.5 && ratio < 5.0, `admitted-seconds ratio ${ratio.toFixed(2)} (want ~4)`);
  // 60 s parked: the reference has a forward direction, the phone configuration has not
  assert.notStrictEqual(refStopped.confidence, 'NONE');
  assert.strictEqual(phoneStopped.confidence, 'NONE',
                     `a parked driver must not bootstrap the reference (${phoneStopped.admitted_s.toFixed(1)} s)`);

  // moving (50 km/h, above the gate): bit-identical to the reference
  const refMoving = run(reference, 50.0);
  const phoneMoving = run(phone, 50.0);
  assert.strictEqual(phoneMoving.admitted_s, refMoving.admitted_s);
  assert.strictEqual(phoneMoving.confidence, refMoving.confidence);

  // speed unknown (null): the option cannot fire, so the reference behaviour is kept
  const refUnknown = run(reference, null);
  const phoneUnknown = run(phone, null);
  assert.strictEqual(phoneUnknown.admitted_s, refUnknown.admitted_s);
});

// ------------------------------------------------------------------ (b) asymmetric hard limits
test('(b) hard_left_driver_deg / hard_left_passenger_deg split the lateral bound in driver terms', () => {
  // a glance at (left, up) that lands in OTHER: beyond the axis -> cabin, inside it -> lateral
  const glanceClass = (cfg, dyaw, dpitch, confidence = 'CONFIRMED') => {
    const rules = new AttentionRules(cfg);
    let st = null;
    for (let k = 0; k < 20; k++) {
      st = rules.update(k / 15.0, [dyaw, dpitch], true, 30.0, 0.0, confidence, null);
    }
    return { cls: st.glance_class, zone: st.zone };
  };
  const reference = defaultConfig();
  const phone = createConfig({ attention: { hard_left_driver_deg: 75.0, hard_left_passenger_deg: 65.0 } });
  assert.strictEqual(reference.attention.hard_left_driver_deg, null);
  assert.strictEqual(reference.attention.hard_left_passenger_deg, null);

  // reference: symmetric 60 deg -> both sides beyond the axis at 62 deg
  assert.deepStrictEqual(glanceClass(reference, 62.0, 20.0), { cls: 'cabin', zone: 'OTHER' });
  assert.deepStrictEqual(glanceClass(reference, -62.0, 20.0), { cls: 'cabin', zone: 'OTHER' });
  // phone: 62 deg is inside both bounds -> lateral; 70 deg passes the passenger bound only
  assert.deepStrictEqual(glanceClass(phone, 62.0, 20.0), { cls: 'lateral', zone: 'OTHER' });
  assert.deepStrictEqual(glanceClass(phone, -62.0, 20.0), { cls: 'lateral', zone: 'OTHER' });
  assert.deepStrictEqual(glanceClass(phone, -70.0, 20.0), { cls: 'cabin', zone: 'OTHER' });
  assert.deepStrictEqual(glanceClass(phone, 70.0, 20.0), { cls: 'lateral', zone: 'OTHER' });
  assert.deepStrictEqual(glanceClass(phone, 78.0, 22.0), { cls: 'cabin', zone: 'OTHER' });

  // the provisional margin still widens both bounds by 5 deg
  assert.strictEqual(glanceClass(reference, 62.0, 20.0, 'PROVISIONAL').cls, 'lateral');
  assert.strictEqual(glanceClass(phone, -70.0, 20.0, 'PROVISIONAL').cls, 'lateral');

  // right-hand drive: the same DRIVER-terms bounds, mirrored in the camera frame
  const rhd = createConfig({
    attention: { driver_side: 'right', hard_left_driver_deg: 75.0, hard_left_passenger_deg: 65.0 },
  });
  assert.deepStrictEqual(glanceClass(rhd, -70.0, 20.0), { cls: 'lateral', zone: 'OTHER' });  // driver's side
  assert.deepStrictEqual(glanceClass(rhd, 70.0, 20.0), { cls: 'cabin', zone: 'OTHER' });     // passenger's side
});

// ------------------------------------------------------------------ (c) seedStale
test('(c) seedStale re-validates a matching stored reference and replaces a moved one', () => {
  const seedAndDrive = (referenceVec, headMode, seconds) => {
    const monitor = new DriverMonitor(defaultConfig());
    monitor.calibration.seedStale(referenceVec, headMode, 0.0);
    const driver = new SyntheticDriver({ fps: 15.0, seed: 5 });
    const outs = drive(monitor, driver, seconds);
    const events = [];
    for (const o of outs) for (const e of o.events) events.push(e);
    return { outs, events };
  };
  const truth = anglesToVector(5.0, -3.0);          // the synthetic driver's forward direction
  const headMode = [4.0, -2.0];                     // its resting head pose

  // the stored reference is still right -> the reference's own re-validation path confirms it
  const good = seedAndDrive(truth, headMode, 30.0);
  assert.strictEqual(good.outs[0].confidence, 'STALE');
  assert.ok(Number.isFinite(good.outs[0].head_dev_deg),
            'a seeded head mode must make the head deviation available on the first frame');
  const revalidated = good.events.filter((e) => e.type === EventType.CALIBRATION_PROVISIONAL);
  assert.ok(revalidated.length > 0, 'no CALIBRATION_PROVISIONAL');
  assert.ok(revalidated[0].detail.startsWith('revalidated'), revalidated[0].detail);
  assert.ok(revalidated[0].t <= 25.0, `revalidated at ${revalidated[0].t.toFixed(1)} s`);
  assert.strictEqual(good.outs[good.outs.length - 1].confidence, 'PROVISIONAL');
  assert.ok(good.events.every((e) => e.type !== EventType.RECALIBRATED));

  // the phone was re-mounted 15 deg away -> the short mode replaces it
  const moved = seedAndDrive(anglesToVector(20.0, -3.0), headMode, 70.0);
  const recal = moved.events.filter((e) => e.type === EventType.RECALIBRATED);
  assert.ok(recal.length > 0, 'no RECALIBRATED');
  assert.ok(recal[0].t <= 60.0, `recalibrated at ${recal[0].t.toFixed(1)} s`);
  const last = moved.outs[moved.outs.length - 1];
  assert.ok(Math.abs(last.reference_yaw - 5.0) < 2.0, `reference yaw ${last.reference_yaw}`);

  // without a head mode the gate waits for the histogram, exactly as before
  const noHead = new DriverMonitor(defaultConfig());
  noHead.calibration.seedStale(truth, null, 0.0);
  const first = drive(noHead, new SyntheticDriver({ fps: 15.0, seed: 5 }), 1.0)[0];
  assert.ok(!Number.isFinite(first.head_dev_deg));
  assert.strictEqual(first.confidence, 'STALE');
});

// ------------------------------------------------------------------ (d) ear_open_freeze_s
test('(d) ear_open_freeze_s floors the open-eye baseline as the driver deteriorates', () => {
  const fps = 20.0;
  const stream = [];
  for (let k = 0; k < Math.round(420 * fps); k++) {
    const t = k / fps;
    // 120 s alert at 0.32, then a slow drift to 0.22 over 300 s (drooping lids)
    const ear = t <= 120.0 ? EAR_OPEN : EAR_OPEN - 0.10 * Math.min(1.0, (t - 120.0) / 300.0);
    stream.push(earFrame(t, ear));
  }
  const off = runTracker(defaultConfig(), stream);
  const on = runTracker(createConfig({ drowsiness: { ear_open_freeze_s: 120.0, ear_open_freeze_ratio: 0.9 } }), stream);
  assert.strictEqual(defaultConfig().drowsiness.ear_open_freeze_s, 0.0);

  const offFinal = off.states[off.states.length - 1].ear_open_baseline;
  const onFinal = on.states[on.states.length - 1].ear_open_baseline;
  assert.ok(offFinal < 0.25, `without the option the baseline follows the driver down: ${offFinal}`);
  assert.ok(onFinal >= 0.288, `with the option the baseline is floored at 0.9 x 0.32: ${onFinal}`);
  // the two agree while the driver is still alert (before the freeze point)
  const early = Math.round(60 * fps);
  assert.strictEqual(on.states[early].ear_open_baseline, off.states[early].ear_open_baseline);
  // reset() clears the frozen value
  on.tracker.reset();
  assert.strictEqual(on.tracker.ear_open_frozen, null);
});

// ------------------------------------------------------------------ (e) perclos_blink_exclude_s
test('(e) perclos_blink_exclude_s takes normal blinks out of PERCLOS but keeps droops', () => {
  const fps = 30.0;
  const blinks = closureStream(fps, 150.0, 4.0, 0.4);           // 15 blinks / min, 0.2-s closures
  const off = runTracker(defaultConfig(), blinks);
  const on = runTracker(createConfig({ drowsiness: { perclos_blink_exclude_s: 0.25 } }), blinks);
  assert.strictEqual(defaultConfig().drowsiness.perclos_blink_exclude_s, 0.0);

  const perclosOf = (r) => r.states[r.states.length - 1].perclos;
  assert.ok(perclosOf(off) >= 0.02 && perclosOf(off) <= 0.05,
            `blinks inflate PERCLOS without the option: ${perclosOf(off)}`);
  assert.ok(perclosOf(on) < 0.002, `with the option the blinks leave PERCLOS: ${perclosOf(on)}`);
  assert.ok(on.states[on.states.length - 1].perclos_long < 0.002, 'the 180-s window too');
  // the blink events themselves are untouched
  const blinkCount = (r) => r.events.filter((e) => e.type === EventType.BLINK).length;
  assert.strictEqual(blinkCount(on), blinkCount(off));
  assert.ok(blinkCount(on) > 25, `${blinkCount(on)} blinks`);

  // a closure just past the window (0.267 s) is kept: the boundary is the closure duration
  const edge = closureStream(fps, 150.0, 5.0, 0.6);
  const edgeOff = runTracker(defaultConfig(), edge);
  const edgeOn = runTracker(createConfig({ drowsiness: { perclos_blink_exclude_s: 0.25 } }), edge);
  assert.ok(Math.abs(perclosOf(edgeOn) - perclosOf(edgeOff)) < 1e-9,
            `a 0.267-s closure must stay in PERCLOS: ${perclosOf(edgeOn)} vs ${perclosOf(edgeOff)}`);

  // a 2-s droop is far longer than the exclusion window: both configurations keep it
  const droops = closureStream(fps, 150.0, 20.0, 2.0);
  const droopOff = runTracker(defaultConfig(), droops);
  const droopOn = runTracker(createConfig({ drowsiness: { perclos_blink_exclude_s: 0.25 } }), droops);
  assert.ok(perclosOf(droopOff) > 0.03, `${perclosOf(droopOff)}`);
  assert.ok(Math.abs(perclosOf(droopOn) - perclosOf(droopOff)) < 1e-9,
            `${perclosOf(droopOn)} vs ${perclosOf(droopOff)}`);
});

// ------------------------------------------------------------------ (f) blink_stats_min_fps
test('(f) blink_stats_min_fps zeroes the blink statistics on a slow stream', () => {
  const cfgOn = createConfig({ drowsiness: { blink_stats_min_fps: 15.0 } });
  const stats = (cfg, fps) => {
    const r = runTracker(cfg, closureStream(fps, 150.0, 4.0, 0.2));
    const s = r.states[r.states.length - 1];
    return [s.blink_rate_per_min, s.blink_mean_duration_s, s.long_blink_count];
  };
  assert.strictEqual(defaultConfig().drowsiness.blink_stats_min_fps, 0.0);
  const fast = stats(cfgOn, 30.0);
  assert.ok(fast[0] > 5.0 && fast[1] > 0.0, `30 Hz must still report: ${fast}`);
  assert.deepStrictEqual(stats(cfgOn, 10.0), [0.0, 0.0, 0]);        // 0.1 s > 1 / 15 s
  const slowOff = stats(defaultConfig(), 10.0);
  assert.ok(slowOff[0] > 5.0, `without the option 10 Hz still reports: ${slowOff}`);
  assert.deepStrictEqual(stats(defaultConfig(), 30.0), fast);       // the option is inert at 30 Hz
});

// ------------------------------------------------------------------ (g) perclos_advisory
test('(g) perclos_advisory emits an INFO hint at most every 300 s while still ALERT', () => {
  const fps = 20.0;
  // 1.5-s dips every 6 s: PERCLOS ~0.089 - above the app's advisory level (0.08), below DROWSY
  // (0.15) and with a score (~42) below score_drowsy, so the level stays ALERT
  const stream = closureStream(fps, 200.0, 6.0, 1.5);
  const off = runTracker(defaultConfig(), stream);
  const on = runTracker(createConfig({ drowsiness: { perclos_advisory: 0.08 } }), stream);
  assert.strictEqual(defaultConfig().drowsiness.perclos_advisory, null);

  const advisories = (r) => r.events.filter((e) => e.type === EventType.PERCLOS_ADVISORY);
  assert.strictEqual(advisories(off).length, 0, 'the default must not emit anything');
  assert.strictEqual(advisories(on).length, 1, `${advisories(on).length} advisories in 200 s`);
  const e = advisories(on)[0];
  assert.strictEqual(e.severity, Severity.INFO);
  assert.strictEqual(e.sound, null);
  assert.strictEqual(e.message, 'Consider a break soon');
  assert.ok(e.value >= 0.08, `${e.value}`);
  assert.strictEqual(on.states[on.states.length - 1].level, 'ALERT');
  assert.strictEqual(on.states[on.states.length - 1].perclos_advisory, true);
  assert.strictEqual(off.states[off.states.length - 1].perclos_advisory, false);
  assert.strictEqual(on.states[Math.round(10 * fps)].perclos_advisory, false, 'not before PERCLOS is valid');

  // an INFO event is never voiced by the arbiter
  const arbiter = new AlertArbiter(defaultConfig());
  const [voiced, active] = arbiter.update(e.t, [e]);
  assert.strictEqual(voiced, null);
  assert.ok(!active.includes(EventType.PERCLOS_ADVISORY));

  // it repeats once the 300-s interval has passed
  const long = runTracker(createConfig({ drowsiness: { perclos_advisory: 0.08 } }),
                          closureStream(10.0, 700.0, 6.0, 1.5));
  assert.ok(advisories(long).length >= 2, `${advisories(long).length} advisories in 700 s`);
  const gaps = advisories(long).slice(1).map((x, i) => x.t - advisories(long)[i].t);
  for (const g of gaps) assert.ok(g >= 300.0, `advisories ${g.toFixed(1)} s apart`);
});

// ------------------------------------------------------------------ the app profile
test('createAppConfig sets exactly these options and stays valid', () => {
  const app = createAppConfig({ sensitivity: 'relaxed', driverSide: 'right', focalScale: 0.9 });
  assert.strictEqual(app.calibration.stationary_weight, 0.25);
  assert.strictEqual(app.attention.hard_left_driver_deg, 75.0);
  assert.strictEqual(app.attention.hard_left_passenger_deg, 65.0);
  assert.strictEqual(app.drowsiness.ear_open_freeze_s, 120.0);
  assert.strictEqual(app.drowsiness.ear_open_freeze_ratio, 0.9);
  assert.strictEqual(app.drowsiness.perclos_blink_exclude_s, 0.25);
  assert.strictEqual(app.drowsiness.blink_stats_min_fps, 15.0);
  assert.strictEqual(app.drowsiness.perclos_advisory, 0.08);
  assert.strictEqual(app.attention.driver_side, 'right');
  assert.strictEqual(app.front_end.focal_scale, 0.9);
  assert.strictEqual(app.attention.long_glance_s, 3.5);          // relaxed profile
  assert.strictEqual(createAppConfig().attention.long_glance_s, 3.0);  // standard = the reference
  // a monitor accepts it (validate() runs in the constructor)
  const monitor = new DriverMonitor(app);
  const out = monitor.processPrediction(0.0, null, null, FrameFeatures({ t: 0.0, face_present: false }));
  assert.strictEqual(out.confidence, 'NONE');
  void Event;
});
