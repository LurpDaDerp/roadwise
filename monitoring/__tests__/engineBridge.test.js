'use strict';
/**
 * `MonitoringBridge` against the real rule engine.
 *
 * The scenario suite drives the ported engine with the JS `SyntheticDriver` (the same harness the
 * `dms/` behaviour gate uses, on its own RNG stream), records the engine outputs and replays them
 * through the bridge, so the assertions are about the TRANSLATION and not about the engine: the
 * expected episodes are derived from the engine's own voiced events.
 *
 *   node --test "monitoring/__tests__/*.test.js" "hooks/__tests__/*.test.js"
 */

const test = require('node:test');
const assert = require('node:assert');

const { Event, EventType, Severity } = require('../../dms/alerts');
const { createAppConfig } = require('../../dms/app_config');
const { Run, EAR_OPEN } = require('../../dms/tests/synthetic');
const { ALERT_SEVERITY, ALERT_TYPE, CALIBRATION_STATE, MONITOR_STATUS } = require('../types');
const {
  MonitoringBridge,
  EVENT_TO_ALERT,
  severityOf,
  DROWSINESS_HISTORY_MAX,
} = require('../engineBridge');

// ------------------------------------------------------------------ helpers
function out(t, fields = {}) {
  return Object.assign({
    t,
    face_present: true,
    eyes_readable: true,
    confidence: 'CONFIRMED',
    concentration: 0.72,
    admitted_s: 120,
    glance_class: 'forward',
    glance_s: 0,
    zone: 'ROAD',
    openness: 1.0,
    drowsiness_level: 'ALERT',
    drowsiness_score: 0,
    perclos: 0.02,
    perclos_long: 0.02,
    events: [],
    voiced: null,
  }, fields);
}

function withEvent(o, event, voiced = true) {
  o.events = [event];
  o.voiced = voiced ? event : null;
  return o;
}

function feed(bridge, frames) {
  let last = null;
  for (const f of frames) last = bridge.update(f);
  return last;
}

/** A bridge with a fixed wall clock, running. */
function makeBridge(extra = {}) {
  const b = new MonitoringBridge(Object.assign({ config: createAppConfig({}), now: () => 1_000_000 }, extra));
  b.setSession('running');
  return b;
}

// ------------------------------------------------------------------ mapping
test('every mapped engine event has copy, and the unmapped ones stay metrics-only', () => {
  const { ALERT_COPY } = require('../types');
  for (const [engineType, alertType] of Object.entries(EVENT_TO_ALERT)) {
    assert.ok(ALERT_COPY[alertType], `${engineType} -> ${alertType} has no copy`);
  }
  for (const silent of [EventType.ATTENTION_BUFFER_EMPTY, EventType.PROLONGED_CLOSURE, EventType.SLOW_BLINKS,
    EventType.BLINK, EventType.DROWSINESS_RECOVERED, EventType.CALIBRATION_CONFIRMED,
    EventType.CALIBRATION_PROVISIONAL, EventType.RECALIBRATED, EventType.REFERENCE_STALE,
    EventType.CAMERA_MOVED, EventType.DRIVER_CHANGE]) {
    assert.strictEqual(EVENT_TO_ALERT[silent], undefined, `${silent} must not become an alert`);
  }
});

test('the severity rule: CRITICAL, then WARNING only when the engine made it audible', () => {
  assert.strictEqual(severityOf(new Event(EventType.EYES_CLOSED, 1, 0, 1)), ALERT_SEVERITY.CRITICAL);
  assert.strictEqual(severityOf(new Event(EventType.LONG_GLANCE, 1, 0, 1)), ALERT_SEVERITY.WARNING);
  assert.strictEqual(
    severityOf(new Event(EventType.HEAD_DOWN, 1, 0, 1, '', { audible: false })),
    ALERT_SEVERITY.INFO, 'a head rule the engine kept silent is info'
  );
  assert.strictEqual(
    severityOf(new Event(EventType.HEAD_DOWN, 1, 0, 1, '', { audible: true })),
    ALERT_SEVERITY.WARNING
  );
  assert.strictEqual(severityOf(new Event(EventType.OFF_ROAD_GLANCE, 1, 0, 1, '', { audible: false })), ALERT_SEVERITY.INFO);
});

test('SLEEP and EYES_CLOSED are one continuing EYES_CLOSED episode', () => {
  const b = makeBridge();
  const closure = { glance_class: 'none', openness: 0.05 };
  b.update(out(100, closure));
  b.update(withEvent(out(101, closure), new Event(EventType.SLEEP, 101, 98, 3)));
  b.update(withEvent(out(104, closure), new Event(EventType.EYES_CLOSED, 104, 98, 6)));
  const snap = b.snapshot();
  assert.strictEqual(snap.activeAlert.type, ALERT_TYPE.EYES_CLOSED);
  assert.strictEqual(snap.metrics.alertsByType[ALERT_TYPE.EYES_CLOSED], 1, 'one episode, not two');
  assert.strictEqual(snap.metrics.alertCounts.critical, 1);
});

test('a warning that is not voiced by the arbiter never becomes an alert', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }),
                     new Event(EventType.LONG_GLANCE, 10, 7, 3.2), false));
  const snap = b.snapshot();
  assert.strictEqual(snap.activeAlert, null, 'the speed gate / cooldown already decided');
  assert.strictEqual(snap.metrics.alertCounts.warning, 0);
});

// ------------------------------------------------------------------ episodes
test('the 2 s escalations and 1.5 s critical repeats extend one episode', () => {
  const b = makeBridge();
  const glance = { glance_class: 'cabin', glance_s: 3.2, zone: 'LAP' };
  b.update(withEvent(out(10, glance), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  b.update(withEvent(out(12, glance), new Event(EventType.LONG_GLANCE, 12, 7, 5)));
  b.update(withEvent(out(14, glance), new Event(EventType.LONG_GLANCE, 14, 7, 7)));
  const snap = b.snapshot();
  assert.strictEqual(snap.metrics.alertCounts.warning, 1);
  assert.strictEqual(snap.metrics.alertsByType[ALERT_TYPE.LONG_GLANCE], 1);
  assert.strictEqual(snap.activeAlert.id, `${ALERT_TYPE.LONG_GLANCE}@7`);
});

test('a glance episode ends after 1 s of forward gaze, and a new glance is a new episode', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  assert.ok(b.snapshot().activeAlert);
  // 4 s of INFO minimum does not apply to a WARNING: only the forward clock does
  b.update(out(10.5, { glance_class: 'forward' }));
  assert.ok(b.snapshot().activeAlert, '0.5 s forward is not enough');
  b.update(out(11.6, { glance_class: 'forward' }));
  assert.strictEqual(b.snapshot().activeAlert, null, 'cleared after 1 s forward');

  b.update(withEvent(out(30, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 30, 27, 3)));
  assert.strictEqual(b.snapshot().metrics.alertsByType[ALERT_TYPE.LONG_GLANCE], 2);
});

test('a glance episode also ends when its events stop for 3 s', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  b.update(out(12, { glance_class: 'cabin', glance_s: 5 }));
  assert.ok(b.snapshot().activeAlert);
  b.update(out(13.5, { glance_class: 'cabin', glance_s: 6.5 }));
  assert.strictEqual(b.snapshot().activeAlert, null);
});

test('a closure episode ends 1 s after the eyes reopen', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { openness: 0.1, glance_class: 'none' }), new Event(EventType.MICROSLEEP, 10, 8.5, 1.5)));
  assert.strictEqual(b.snapshot().activeAlert.type, ALERT_TYPE.MICROSLEEP);
  b.update(out(11, { openness: 0.6, glance_class: 'forward' }));
  assert.ok(b.snapshot().activeAlert, 'the overlay does not vanish on the first open frame');
  b.update(out(12.1, { openness: 0.6, glance_class: 'forward' }));
  assert.strictEqual(b.snapshot().activeAlert, null);
});

test('NO_FACE ends when the face returns, EYES_NOT_VISIBLE when the eyes are readable', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { face_present: false, glance_class: 'none' }),
                     new Event(EventType.DRIVER_NOT_VISIBLE, 10, 0, 10, '', { audible: true })));
  assert.strictEqual(b.snapshot().activeAlert.type, ALERT_TYPE.NO_FACE);
  b.update(out(14.5, { face_present: false }));
  assert.ok(b.snapshot().activeAlert);
  b.update(out(15, { face_present: true }));
  assert.strictEqual(b.snapshot().activeAlert, null);

  const c = makeBridge();
  c.update(withEvent(out(20, { eyes_readable: false }), new Event(EventType.EYES_UNREADABLE, 20, 10, 10)));
  assert.strictEqual(c.snapshot().activeAlert.type, ALERT_TYPE.EYES_NOT_VISIBLE);
  c.update(out(26, { eyes_readable: false }));
  assert.ok(c.snapshot().activeAlert, 'still unreadable');
  c.update(out(27, { eyes_readable: true }));
  assert.strictEqual(c.snapshot().activeAlert, null);
});

test('drowsiness-family episodes linger 8 s after their last event', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { drowsiness_level: 'DROWSY' }), new Event(EventType.DROWSY, 10, 10, 30)));
  assert.strictEqual(b.snapshot().activeAlert.type, ALERT_TYPE.DROWSY);
  b.update(out(17, { drowsiness_level: 'DROWSY' }));
  assert.ok(b.snapshot().activeAlert);
  b.update(out(18.5, { drowsiness_level: 'DROWSY' }));
  assert.strictEqual(b.snapshot().activeAlert, null);
});

test('an INFO alert never pre-empts or interrupts a live WARNING', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  b.update(withEvent(out(10.5, { glance_class: 'cabin', glance_s: 3.7 }),
                     new Event(EventType.OFF_ROAD_GLANCE, 10.5, 10.2, 0.3, 'LAP', { audible: false }), false));
  const snap = b.snapshot();
  assert.strictEqual(snap.activeAlert.type, ALERT_TYPE.LONG_GLANCE);
  assert.strictEqual(snap.metrics.alertCounts.info, 0, 'the info event did not even start an episode');
});

test('an INFO banner stays readable for 4 s', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 0.5 }),
                     new Event(EventType.OFF_ROAD_GLANCE, 10, 9.6, 0.4, 'LAP', { audible: false }), false));
  assert.strictEqual(b.snapshot().activeAlert.severity, ALERT_SEVERITY.INFO);
  b.update(out(12, { glance_class: 'forward' }));
  assert.ok(b.snapshot().activeAlert, 'still readable at 2 s');
  b.update(out(14.5, { glance_class: 'forward' }));
  assert.strictEqual(b.snapshot().activeAlert, null);
});

test('a CRITICAL outranks a live WARNING', () => {
  const b = makeBridge();
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  b.update(withEvent(out(11, { glance_class: 'cabin', glance_s: 4.2, openness: 0.1 }),
                     new Event(EventType.MICROSLEEP, 11, 9.5, 1.5)));
  assert.strictEqual(b.snapshot().activeAlert.type, ALERT_TYPE.MICROSLEEP);
  assert.strictEqual(b.snapshot().activeAlert.severity, ALERT_SEVERITY.CRITICAL);
});

test('an escalating episode keeps its id and moves its single count up', () => {
  const b = makeBridge();
  // DRIVER_NOT_VISIBLE is info at 5 s (silent) and warning at 10 s (audible), same t_start
  b.update(withEvent(out(10, { face_present: false, glance_class: 'none' }),
                     new Event(EventType.DRIVER_NOT_VISIBLE, 10, 5, 5, '', { audible: false }), false));
  const first = b.snapshot();
  assert.strictEqual(first.activeAlert.severity, ALERT_SEVERITY.INFO);
  assert.strictEqual(first.metrics.alertCounts.info, 1);

  b.update(withEvent(out(15, { face_present: false, glance_class: 'none' }),
                     new Event(EventType.DRIVER_NOT_VISIBLE, 15, 5, 10, '', { audible: true })));
  const second = b.snapshot();
  assert.strictEqual(second.activeAlert.id, first.activeAlert.id, 'same episode id');
  assert.strictEqual(second.activeAlert.severity, ALERT_SEVERITY.WARNING);
  assert.strictEqual(second.metrics.alertCounts.info, 0, 'the count moved, it did not duplicate');
  assert.strictEqual(second.metrics.alertCounts.warning, 1);
  assert.strictEqual(second.metrics.alertsByType[ALERT_TYPE.NO_FACE], 1);
});

test('acknowledge ends the episode, suppresses it and tells the engine', () => {
  const calls = [];
  const b = makeBridge({ monitor: { acknowledge: (t) => calls.push(t), resetCalibration: () => {} } });
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  const id = b.snapshot().activeAlert.id;
  b.acknowledge(id);
  assert.strictEqual(b.snapshot().activeAlert, null);
  assert.deepStrictEqual(calls, [10]);
  b.update(withEvent(out(12, { glance_class: 'cabin', glance_s: 5 }), new Event(EventType.LONG_GLANCE, 12, 7, 5)));
  assert.strictEqual(b.snapshot().activeAlert, null, 'the same episode does not come back');
  assert.strictEqual(b.snapshot().metrics.alertCounts.warning, 1);
});

// ------------------------------------------------------------------ metrics
test('eyes off the road counts the glance beyond its class allowance', () => {
  const b = makeBridge();
  let t = 0;
  const step = (fields, seconds) => {
    for (let i = 0; i < seconds * 10; i++) {
      t += 0.1;
      b.update(out(t, fields));
    }
  };
  step({ glance_class: 'forward' }, 5);
  assert.strictEqual(Math.round(b.metrics.eyesOffRoadSeconds), 0);
  // a 3 s cabin glance counts from the first second (allowance 0)
  step({ glance_class: 'cabin', glance_s: 1.5, zone: 'LAP' }, 3);
  assert.ok(Math.abs(b.metrics.eyesOffRoadSeconds - 3) < 0.25, `${b.metrics.eyesOffRoadSeconds}`);
  // a 3 s lateral glance counts only beyond 2 s
  const before = b.metrics.eyesOffRoadSeconds;
  step({ glance_class: 'lateral', glance_s: 1.0 }, 2);
  step({ glance_class: 'lateral', glance_s: 3.0 }, 2);
  assert.ok(Math.abs(b.metrics.eyesOffRoadSeconds - before - 2) < 0.25, `${b.metrics.eyesOffRoadSeconds - before}`);
  // a head-down frame counts even without a glance class
  const before2 = b.metrics.eyesOffRoadSeconds;
  step({ glance_class: 'none', zone: 'LOOK_DOWN' }, 2);
  assert.ok(Math.abs(b.metrics.eyesOffRoadSeconds - before2 - 2) < 0.25);
});

test('the drowsiness level maps ALERT/hint/DROWSY/SEVERE onto 0..3', () => {
  const b = makeBridge();
  assert.strictEqual(b.update(out(1)).drowsiness.level, 0);
  assert.strictEqual(b.update(out(2, { perclos: 0.09 })).drowsiness.level, 1, 'the 8 % advisory');
  assert.strictEqual(b.update(out(3, { drowsiness_score: 30 })).drowsiness.level, 1);
  assert.strictEqual(b.update(out(4, { drowsiness_level: 'DROWSY' })).drowsiness.level, 2);
  assert.strictEqual(b.update(out(5, { drowsiness_level: 'SEVERE' })).drowsiness.level, 3);
  assert.strictEqual(b.snapshot().metrics.drowsinessPeak, 3);
  assert.strictEqual(b.update(out(6, { perclos: NaN })).drowsiness.perclos, null);
});

test("the engine's PERCLOS_ADVISORY event raises one INFO episode per emission", () => {
  const b = makeBridge();
  b.update(out(10, { perclos: 0.02 }));
  const advisory = (t) => new Event(EventType.PERCLOS_ADVISORY, t, t - 60, 0.09);
  b.update(withEvent(out(11, { perclos: 0.09 }), advisory(11), false));
  assert.strictEqual(b.snapshot().activeAlert.type, ALERT_TYPE.PERCLOS);
  assert.strictEqual(b.snapshot().activeAlert.severity, ALERT_SEVERITY.INFO);
  b.update(out(12, { perclos: 0.10 }));
  assert.strictEqual(b.snapshot().metrics.alertsByType[ALERT_TYPE.PERCLOS], 1, 'a high PERCLOS alone raises nothing');
  b.update(out(30, { perclos: 0.01 }));
  b.update(withEvent(out(311, { perclos: 0.09 }), advisory(311), false));
  assert.strictEqual(b.snapshot().metrics.alertsByType[ALERT_TYPE.PERCLOS], 2, 'the next emission counts again');
});

test('the drowsiness history samples every 10 s and is capped at 120', () => {
  const b = makeBridge();
  for (let t = 0; t <= 2000; t += 0.5) b.update(out(t));
  const h = b.snapshot().metrics.drowsinessHistory;
  assert.strictEqual(h.length, DROWSINESS_HISTORY_MAX);
  assert.strictEqual(h[h.length - 1].t, 2000, 'the newest sample is kept');
  assert.ok(h[1].t - h[0].t >= 10);
  for (const s of h) {
    assert.ok(Number.isFinite(s.t) && Number.isFinite(s.level));
  }
});

test('calibration quality is null until the reference is usable and discounted while provisional', () => {
  const b = makeBridge();
  assert.strictEqual(b.update(out(1, { confidence: 'NONE', concentration: 0.7 })).calibration.quality, null);
  const prov = b.update(out(2, { confidence: 'PROVISIONAL', concentration: 0.8 })).calibration;
  assert.strictEqual(prov.state, CALIBRATION_STATE.PROVISIONAL);
  assert.strictEqual(prov.quality, 0.7, '1.0 x 0.7 while provisional');
  const conf = b.update(out(3, { confidence: 'CONFIRMED', concentration: 0.4 })).calibration;
  assert.strictEqual(conf.state, CALIBRATION_STATE.CONFIRMED);
  assert.strictEqual(conf.quality, 0.5);
});

test('calibration progress is the admitted seconds toward 60', () => {
  const b = makeBridge();
  assert.strictEqual(b.update(out(1, { confidence: 'NONE', admitted_s: 15 })).calibration.progress, 0.25);
  assert.strictEqual(b.update(out(2, { confidence: 'NONE', admitted_s: 120 })).calibration.progress, 1);
});

test('a moved camera shows LOST for 5 s, a stale reference shows LOST while it lasts', () => {
  const b = makeBridge();
  b.update(out(10));
  b.update(withEvent(out(11), new Event(EventType.CAMERA_MOVED, 11, 1, 10), false));
  assert.strictEqual(b.snapshot().calibration.state, CALIBRATION_STATE.LOST);
  assert.strictEqual(b.update(out(14)).calibration.state, CALIBRATION_STATE.LOST);
  assert.strictEqual(b.update(out(17)).calibration.state, CALIBRATION_STATE.CONFIRMED);
  assert.strictEqual(b.update(out(18, { confidence: 'STALE' })).calibration.state, CALIBRATION_STATE.LOST);
});

test('recalibrate() resets the engine and shows LOST', () => {
  let reset = 0;
  const b = makeBridge({ monitor: { resetCalibration: () => { reset += 1; }, acknowledge: () => {} } });
  b.update(out(10));
  b.recalibrate();
  assert.strictEqual(reset, 1);
  assert.strictEqual(b.calibration().state, CALIBRATION_STATE.LOST);
  assert.strictEqual(b.calibration().quality, null);
});

test('status follows the session, then the face and the calibration', () => {
  const b = new MonitoringBridge({ config: createAppConfig({}) });
  assert.strictEqual(b.status(), MONITOR_STATUS.OFF);
  b.setSession('permission_denied');
  assert.strictEqual(b.status(), MONITOR_STATUS.PERMISSION_DENIED);
  b.setSession('camera_error');
  assert.strictEqual(b.status(), MONITOR_STATUS.CAMERA_ERROR);
  b.setSession('starting');
  assert.strictEqual(b.status(), MONITOR_STATUS.STARTING);
  b.setSession('running');
  assert.strictEqual(b.status(), MONITOR_STATUS.STARTING, 'no frame yet');
  b.update(out(1, { confidence: 'NONE' }));
  assert.strictEqual(b.status(), MONITOR_STATUS.CALIBRATING);
  b.update(out(2));
  assert.strictEqual(b.status(), MONITOR_STATUS.ACTIVE);
  b.update(out(9, { face_present: false }));
  assert.strictEqual(b.status(), MONITOR_STATUS.NO_FACE);
  b.update(out(10));
  assert.strictEqual(b.status(), MONITOR_STATUS.ACTIVE);
});

test('points hold and the streak rule', () => {
  const b = makeBridge();
  assert.strictEqual(b.pointsBlocked(0), false);
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  assert.strictEqual(b.pointsBlocked(10), true);
  assert.strictEqual(b.pointsBlocked(19), true);
  assert.strictEqual(b.pointsBlocked(21), false);
  assert.strictEqual(b.streakBreaking(), false, 'one glance costs points, not the streak');

  b.update(withEvent(out(40, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.PHONE_PATTERN, 40, 30, 3)));
  b.update(withEvent(out(70, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.VATS_DISTRACTION, 70, 45, 11)));
  assert.strictEqual(b.streakBreaking(), true, 'three distraction episodes');

  const c = makeBridge();
  c.update(withEvent(out(10, { openness: 0.05, glance_class: 'none' }), new Event(EventType.EYES_CLOSED, 10, 4, 6)));
  assert.strictEqual(c.streakBreaking(), true, 'one eyes-closed event is enough');
  assert.strictEqual(c.pointsBlocked(11), false, 'a closure is not a distraction episode');

  const d = makeBridge();
  d.update(out(10, { drowsiness_level: 'SEVERE' }));
  assert.strictEqual(d.pointsBlocked(10), true, 'severe drowsiness holds points');
});

test('metrics and engineDetail are plain, finite, Firestore-safe values', () => {
  const b = makeBridge();
  b.noteStatus({ fps: 19.4, intrinsicsSource: 'fov', focalScale: 0.9, parity: { ok: true }, permission: 'granted' });
  b.update(withEvent(out(10, { glance_class: 'cabin', glance_s: 3.2, concentration: NaN, perclos: NaN }),
                     new Event(EventType.LONG_GLANCE, 10, 7, 3)));
  const walk = (v, path) => {
    if (v === null) return;
    const type = typeof v;
    if (type === 'number') return assert.ok(Number.isFinite(v), `${path} = ${v}`);
    if (type === 'string' || type === 'boolean') return;
    assert.notStrictEqual(type, 'undefined', `${path} undefined`);
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    assert.strictEqual(Object.getPrototypeOf(v), Object.prototype, `${path} is a class instance`);
    for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(b.snapshot().metrics, 'metrics');
  walk(b.engineDetail(), 'engineDetail');
  const d = b.engineDetail();
  assert.strictEqual(d.intrinsicsSource, 'fov');
  assert.strictEqual(d.parityOk, true);
  assert.strictEqual(d.fpsMean, 19.4);
  assert.strictEqual(d.engineEpisodes.LONG_GLANCE, 1);
});

test('the version counter only moves when the snapshot changes', () => {
  const b = makeBridge();
  b.update(out(10));
  const v = b.version;
  b.update(out(10.05));
  b.update(out(10.1));
  assert.strictEqual(b.version, v, 'quiet frames do not re-render the UI');
  b.update(withEvent(out(11, { glance_class: 'cabin', glance_s: 3.2 }), new Event(EventType.LONG_GLANCE, 11, 8, 3)));
  assert.ok(b.version > v);
});

// ------------------------------------------------------------------ the engine end to end
test('a full synthetic drive through the real engine', (t) => {
  const config = createAppConfig({});
  const r = new Run(30, { seed: 5, speed: 60, config });     // 150 s of warm-up driving

  r.seg(10);
  r.seg(3.8, { up: -40.0, head_follow: 0.5 });               // a lap look past the 3 s limit
  r.seg(10);
  for (let i = 0; i < 3; i++) {                              // the texting pattern
    r.seg(2.0, { up: -40.0, head_follow: 0.5 });
    r.seg(3.0);
  }
  r.seg(10);
  r.seg(2.2, { eyes_open: false });                          // microsleep
  r.seg(12);
  r.seg(7.0, { eyes_open: false });                          // sleep -> eyes closed
  r.seg(12);
  r.seg(12.0, { face: false });                              // the driver leaves the frame
  r.seg(10);

  const bridge = new MonitoringBridge({ config, now: () => 1_000_000 });
  bridge.setSession('running');

  const states = [];
  const statuses = [];
  let infoOverAudible = 0;
  for (const o of r.outs) {
    bridge.update(o);
    const state = bridge.calibration().state;
    if (states[states.length - 1] !== state) states.push(state);
    const status = bridge.status();
    if (statuses[statuses.length - 1] !== status) statuses.push(status);
    const a = bridge.activeAlert;
    if (a && a.severity === ALERT_SEVERITY.INFO && bridge._hasLiveAudible()) infoOverAudible += 1;
  }

  // --- the bridge counted exactly the engine's own voiced episodes --------------------
  const expected = new Map();
  for (const o of r.outs) {
    const v = o.voiced;
    if (!v) continue;
    const type = EVENT_TO_ALERT[v.type];
    if (!type) continue;
    if (severityOf(v, type) === ALERT_SEVERITY.INFO) continue;
    const key = `${type}@${Math.round(v.t_start * 1000) / 1000}`;
    expected.set(key, type);
  }
  const expectedByType = {};
  for (const type of expected.values()) expectedByType[type] = (expectedByType[type] || 0) + 1;

  const byType = bridge.snapshot().metrics.alertsByType;
  for (const [type, n] of Object.entries(expectedByType)) {
    assert.strictEqual(byType[type], n, `${type}: one alert per voiced episode`);
  }
  t.diagnostic(`alertsByType ${JSON.stringify(byType)}`);
  t.diagnostic(`counts ${JSON.stringify(bridge.snapshot().metrics.alertCounts)}`);
  t.diagnostic(`eyesOffRoadSeconds ${bridge.metrics.eyesOffRoadSeconds.toFixed(2)}`);

  // --- the scenario produced what it was built to produce ------------------------------
  assert.ok(byType[ALERT_TYPE.LONG_GLANCE] >= 1, 'the 3.8 s lap look is a long glance');
  assert.ok(byType[ALERT_TYPE.MICROSLEEP] >= 1, 'the 2.2 s closure is a microsleep');
  assert.ok(byType[ALERT_TYPE.EYES_CLOSED] >= 1, 'the 7 s closure is eyes closed');
  assert.ok(byType[ALERT_TYPE.NO_FACE] >= 1, 'the 12 s absence is driver-not-visible');
  assert.strictEqual(byType[ALERT_TYPE.EYES_CLOSED], 1, 'SLEEP and EYES_CLOSED are one episode');
  assert.ok(bridge.snapshot().metrics.alertCounts.critical >= 2);
  assert.ok(bridge.snapshot().metrics.alertCounts.warning >= 1);

  // --- eyes off the road is the cabin dwell (3.8 + 3 x 2.0 s) plus its ramps ------------
  const eyesOff = bridge.metrics.eyesOffRoadSeconds;
  assert.ok(eyesOff > 6 && eyesOff < 16, `eyesOffRoadSeconds ${eyesOff}`);

  // --- calibration walked the whole ladder ----------------------------------------------
  assert.strictEqual(states[0], CALIBRATION_STATE.CALIBRATING);
  assert.ok(states.indexOf(CALIBRATION_STATE.PROVISIONAL) > 0, `states ${states}`);
  assert.ok(states.indexOf(CALIBRATION_STATE.CONFIRMED) > states.indexOf(CALIBRATION_STATE.PROVISIONAL));
  assert.ok(bridge.engineDetail().calibration.timeToConfirmedS > 0);

  // --- status reached ACTIVE and reported the absence ------------------------------------
  assert.ok(statuses.includes(MONITOR_STATUS.ACTIVE), `statuses ${statuses}`);
  assert.ok(statuses.includes(MONITOR_STATUS.NO_FACE));

  // --- drowsiness and the history --------------------------------------------------------
  assert.ok(bridge.snapshot().metrics.drowsinessPeak >= 1, 'the closures raised the level');
  const history = bridge.snapshot().metrics.drowsinessHistory;
  assert.ok(history.length > 5 && history.length <= DROWSINESS_HISTORY_MAX);
  assert.ok(history[history.length - 1].t >= 200);

  // --- and INFO never stole the banner ----------------------------------------------------
  assert.strictEqual(infoOverAudible, 0);
  assert.ok(bridge.streakBreaking(), 'an eyes-closed drive breaks the streak');
});

test('a quiet synthetic drive stays silent end to end', () => {
  const config = createAppConfig({});
  const r = new Run(30, { seed: 11, speed: 60, config });
  for (let i = 0; i < 6; i++) {                     // mirror checks and cluster glances
    r.seg(6.0); r.seg(1.0, { left: -30.0, up: 15.0 });
    r.seg(5.0); r.seg(0.8, { left: 50.0, up: -5.0 });
    r.seg(8.8); r.seg(1.2, { up: -20.0, head_follow: 0.1 });
  }
  const bridge = new MonitoringBridge({ config, now: () => 1_000_000 });
  bridge.setSession('running');
  for (const o of r.outs) bridge.update(o);
  const m = bridge.snapshot().metrics;
  assert.strictEqual(m.alertCounts.warning, 0, `warnings ${JSON.stringify(m.alertsByType)}`);
  assert.strictEqual(m.alertCounts.critical, 0);
  assert.strictEqual(bridge.streakBreaking(), false);
});
