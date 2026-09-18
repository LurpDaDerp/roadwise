'use strict';
/**
 * Behaviour gate (the JS twin of `tools/behavior_eval.py`), run on a DIFFERENT RNG stream than
 * the parity fixtures: normal driving must stay silent, unsafe behaviour must be voiced within
 * its latency.  Scenario shapes and thresholds are the reference's.
 */

const test = require('node:test');
const assert = require('node:assert');

const { EventType, Severity } = require('../alerts');
const { Run, EAR_OPEN, sin } = require('./synthetic');

const CLOSURE_FAMILY = [EventType.PROLONGED_CLOSURE, EventType.MICROSLEEP, EventType.SLEEP, EventType.EYES_CLOSED];
const RATES = [30.0, 15.0, 5.0];

// ------------------------------------------------------------------ negatives
const NEGATIVES = [
  ['scanning', (r) => {
    for (let i = 0; i < 12; i++) {
      r.seg(8.5);
      r.seg(1.5, { left: i % 2 ? 18.0 : -18.0, head_follow: 0.3 });
    }
  }],
  ['mirror_checks', (r) => {
    for (let i = 0; i < 6; i++) {
      r.seg(6.0); r.seg(1.0, { left: -30.0, up: 15.0 });
      r.seg(5.0); r.seg(0.8, { left: 50.0, up: -5.0 });
      r.seg(5.0); r.seg(1.0, { left: -60.0, up: -5.0 });
    }
  }],
  ['cluster_checks', (r) => {
    for (let i = 0; i < 8; i++) {
      r.seg(8.8); r.seg(1.2, { up: -20.0, head_follow: 0.1 });
    }
  }],
  ['shoulder_checks', (r) => {
    for (let i = 0; i < 6; i++) {
      r.seg(10.0); r.seg(1.0, { left: 70.0, head_follow: 0.8 });
    }
  }],
  ['passenger_talk', (r) => {
    for (let i = 0; i < 4; i++) {
      r.seg(10.0); r.seg(2.0, { left: -45.0, head_follow: 0.6 });
      r.seg(8.0); r.seg(1.2, { left: -70.0, up: 10.0, head_follow: 0.7 });
    }
  }],
  ['talking_singing', (r) => {
    r.seg(60.0, { mar: sin(0.175, 4.0, 0.375) });
    for (let i = 0; i < 10; i++) {
      r.seg(4.0); r.seg(1.0, { mar: 0.8 });
    }
  }],
  ['head_bobbing', (r) => {
    r.seg(90.0, { up: sin(6.0, 1.5), head_follow: 1.0 });
  }],
  ['brief_phone_checks', (r) => {
    for (let i = 0; i < 4; i++) {
      r.seg(28.0); r.seg(1.5, { up: -36.0, head_follow: 0.5, ear: 0.6 * EAR_OPEN });
    }
  }],
  ['lowered_lid_looks', (r) => {
    for (let i = 0; i < 3; i++) {
      r.seg(35.0); r.seg(2.5, { up: -36.0, head_follow: 0.5, ear: 0.35 * EAR_OPEN });
    }
  }],
  ['intersection_side_looks', (r) => {
    r.seg(10.0); r.seg(8.0, { left: 30.0, head_follow: 0.6 });
    r.seg(12.0); r.seg(8.0, { left: -35.0, head_follow: 0.6 });
    r.seg(30.0);
  }],
  ['blinking', (r) => {
    r.seg(180.0);
  }],
];

// ------------------------------------------------------------------ positives
const POSITIVES = [
  ['lap_look_3.8s', (r) => { r.seg(10.0); r.mark(); r.seg(3.8, { up: -40.0, head_follow: 0.5 }); },
    [EventType.LONG_GLANCE], 3.5, CLOSURE_FAMILY, null],
  ['texting_pattern', (r) => {
    r.seg(10.0); r.mark();
    for (let i = 0; i < 5; i++) {
      r.seg(1.2, { up: -40.0, head_follow: 0.5, ear: 0.6 * EAR_OPEN });
      r.seg(2.0);
    }
  }, [EventType.PHONE_PATTERN], 10.0, CLOSURE_FAMILY, null],
  ['lowered_lid_phone_look', (r) => { r.seg(10.0); r.mark(); r.seg(4.5, { up: -40.0, head_follow: 0.5, ear: 0.35 * EAR_OPEN }); },
    [EventType.LONG_GLANCE], 3.5, [EventType.MICROSLEEP, EventType.SLEEP, EventType.EYES_CLOSED], null],
  ['side_stare_13.5s', (r) => { r.seg(10.0); r.mark(); r.seg(13.5, { left: 35.0, head_follow: 0.6 }); },
    [EventType.LONG_GLANCE], 12.5, CLOSURE_FAMILY, null],
  ['side_stare_at_50kmh', (r) => { r.seg(10.0); r.mark(); r.seg(5.0, { left: 35.0, head_follow: 0.6 }); },
    [EventType.LONG_GLANCE], 4.5, CLOSURE_FAMILY, 50.0],
  ['passenger_stare', (r) => { r.seg(10.0); r.mark(); r.seg(4.0, { left: -70.0, up: 10.0, head_follow: 0.7 }); },
    [EventType.LONG_GLANCE], 3.5, CLOSURE_FAMILY, null],
  ['microsleep', (r) => { r.seg(10.0); r.mark(); r.seg(2.2, { eyes_open: false }); },
    [EventType.MICROSLEEP], 2.0, [], null],
  ['sleep', (r) => { r.seg(10.0); r.mark(); r.seg(4.0, { eyes_open: false }); },
    [EventType.SLEEP], 3.5, [], null],
  ['eyes_closed', (r) => { r.seg(10.0); r.mark(); r.seg(7.0, { eyes_open: false }); },
    [EventType.EYES_CLOSED], 6.5, [], null],
  ['nodding_off', (r) => {
    r.seg(10.0); r.mark(); r.seg(0.7, { eyes_open: false });
    r.seg(4.0, { eyes_open: false, up: -40.0, head_follow: 0.5 });
  }, [EventType.SLEEP], 3.5, [], null],
  ['drowsy_perclos', (r) => {
    r.mark();
    for (let i = 0; i < 48; i++) {
      r.seg(3.8);
      r.seg(1.2, { eyes_open: false });
    }
  }, [EventType.DROWSY, EventType.SEVERE_DROWSY], 100.0, [EventType.MICROSLEEP], null],
  ['visual_time_sharing', (r) => {
    r.seg(10.0); r.mark();
    for (let i = 0; i < 7; i++) {
      r.seg(2.5, { left: -70.0, up: 10.0, head_follow: 0.7 });
      r.seg(1.0);
    }
  }, [EventType.VATS_DISTRACTION], 16.0, CLOSURE_FAMILY, null],
  ['driver_absent', (r) => { r.seg(10.0); r.mark(); r.seg(12.0, { face: false }); },
    [EventType.DRIVER_NOT_VISIBLE], 10.5, [], null],
];

for (const fps of RATES) {
  for (const [name, builder] of NEGATIVES) {
    test(`negative @${fps} Hz: ${name} is silent`, () => {
      const r = new Run(fps);
      builder(r);
      const voiced = r.voiced(r.t_test);
      const closure = r.events(r.t_test).filter((e) => CLOSURE_FAMILY.includes(e.type));
      assert.deepStrictEqual(voiced.map((v) => `${v.type}@${(v.t - r.t_test).toFixed(1)}(${v.detail})`), []);
      assert.deepStrictEqual(closure.map((e) => `${e.type}@${(e.t - r.t_test).toFixed(1)}`), []);
      assert.ok(['PROVISIONAL', 'CONFIRMED'].includes(r.confidence_at_test), r.confidence_at_test);
    });
  }
}

for (const fps of RATES) {
  for (const [name, builder, want, latency, forbidden, speed] of POSITIVES) {
    test(`positive @${fps} Hz: ${name} voices ${want.join('/')}`, () => {
      const r = new Run(fps, { speed });
      builder(r);
      const t0 = r.t_mark !== null ? r.t_mark : r.t_test;
      const voiced = r.voiced(t0);
      const hits = voiced.filter((v) => want.includes(v.type));
      const bad = [...new Set(r.events(t0).filter((e) => forbidden.includes(e.type)).map((e) => e.type))].sort();
      const tol = latency + 2.0 / fps;
      assert.ok(hits.length > 0,
                `${name}@${fps}: nothing voiced, saw ${JSON.stringify(voiced.map((v) => v.type))}`);
      const first = hits[0].t - t0;
      assert.ok(first <= tol, `${name}@${fps}: latency ${first.toFixed(2)} > ${tol.toFixed(2)}`);
      assert.deepStrictEqual(bad, [], `${name}@${fps}: forbidden events ${bad}`);
    });
  }
}

test('every voiced alert carries a sound and a message', () => {
  const r = new Run(15.0);
  r.seg(10.0);
  r.mark();
  r.seg(5.0, { up: -40.0, head_follow: 0.5 });
  const voiced = r.voiced(r.t_mark);
  assert.ok(voiced.length > 0);
  for (const v of voiced) {
    assert.ok(typeof v.sound === 'string' && v.sound.length > 0, `${v.type} has no sound`);
    assert.ok(typeof v.message === 'string' && v.message.length > 0, `${v.type} has no message`);
    assert.notStrictEqual(v.severity, Severity.INFO);
  }
});
