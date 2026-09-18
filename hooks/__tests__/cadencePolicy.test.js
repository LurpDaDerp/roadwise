'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createCadencePolicy, normalizeThermal } = require('../monitor/cadencePolicy');

const base = { moving: true, thermal: 'nominal', lowPower: false, batteryLevel: 0.8, batteryCharging: false };

test('thermal vocabularies collapse onto one scale', () => {
  assert.strictEqual(normalizeThermal('SEVERE'), 'serious');
  assert.strictEqual(normalizeThermal('serious'), 'serious');
  assert.strictEqual(normalizeThermal('SHUTDOWN'), 'critical');
  assert.strictEqual(normalizeThermal('critical'), 'critical');
  assert.strictEqual(normalizeThermal('fair'), 'fair');
  assert.strictEqual(normalizeThermal(undefined), 'nominal');
});

test('a face at full speed runs at 20 fps', () => {
  const p = createCadencePolicy();
  const r = p.update(Object.assign({ t: 0, facePresent: true }, base));
  assert.strictEqual(r.targetFps, 20);
  assert.strictEqual(r.reason, 'full');
  assert.strictEqual(r.paused, false);
});

test('no face for more than 5 s drops to the 5 fps idle cadence', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({ t: 0, facePresent: true }, base));
  assert.strictEqual(p.update(Object.assign({ t: 4, facePresent: false }, base)).targetFps, 20);
  const r = p.update(Object.assign({ t: 6, facePresent: false }, base));
  assert.strictEqual(r.targetFps, 5);
  assert.strictEqual(r.reason, 'noFace');
  // a face comes back
  assert.strictEqual(p.update(Object.assign({ t: 7, facePresent: true }, base)).targetFps, 20);
});

test('stationary for more than 30 s drops to 10 fps, moving restores 20', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({}, base, { t: 0, facePresent: true, moving: false }));
  assert.strictEqual(p.update(Object.assign({}, base, { t: 20, facePresent: true, moving: false })).targetFps, 20);
  const r = p.update(Object.assign({}, base, { t: 40, facePresent: true, moving: false }));
  assert.strictEqual(r.targetFps, 10);
  assert.strictEqual(r.reason, 'stationary');
  assert.strictEqual(p.update(Object.assign({}, base, { t: 41, facePresent: true, moving: true })).targetFps, 20);
});

test('unknown speed is not stationary', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({}, base, { t: 0, facePresent: true, moving: null }));
  assert.strictEqual(p.update(Object.assign({}, base, { t: 100, facePresent: true, moving: null })).targetFps, 20);
});

test('thermal serious and Low Power Mode each halve the cadence', () => {
  const p = createCadencePolicy();
  let r = p.update(Object.assign({}, base, { t: 0, facePresent: true, thermal: 'serious' }));
  assert.strictEqual(r.targetFps, 10);
  assert.strictEqual(r.reason, 'thermal');
  r = p.update(Object.assign({}, base, { t: 1, facePresent: true, lowPower: true }));
  assert.strictEqual(r.targetFps, 10);
  assert.strictEqual(r.reason, 'lowPower');
});

test('battery below 15 % and not charging reduces; charging does not', () => {
  const p = createCadencePolicy();
  let r = p.update(Object.assign({}, base, { t: 0, facePresent: true, batteryLevel: 0.1 }));
  assert.strictEqual(r.targetFps, 10);
  assert.strictEqual(r.reason, 'lowBattery');
  r = p.update(Object.assign({}, base, { t: 1, facePresent: true, batteryLevel: 0.1, batteryCharging: true }));
  assert.strictEqual(r.targetFps, 20);
});

test('the lowest cadence wins and the most informative reason is reported', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({}, base, { t: 0, facePresent: true }));
  const r = p.update(Object.assign({}, base, { t: 10, facePresent: false, thermal: 'serious' }));
  assert.strictEqual(r.targetFps, 5, 'no face wins on rate');
  assert.strictEqual(r.reason, 'thermal', 'thermal wins on the pill');
});

test('thermal critical pauses and retries only after 60 s at fair', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({}, base, { t: 0, facePresent: true }));
  let r = p.update(Object.assign({}, base, { t: 1, facePresent: true, thermal: 'critical' }));
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.targetFps, 0);
  assert.strictEqual(r.reason, 'thermalPause');

  // still hot at 70 s -> still paused
  r = p.update(Object.assign({}, base, { t: 70, facePresent: true, thermal: 'critical' }));
  assert.strictEqual(r.paused, true);

  // cooled to fair, but the 60 s retry window starts from the pause
  r = p.update(Object.assign({}, base, { t: 71, facePresent: true, thermal: 'fair' }));
  assert.strictEqual(r.paused, false, 'more than 60 s since the pause began and cooled');
  assert.strictEqual(r.resume, true);
  assert.strictEqual(r.targetFps, 20);
});

test('a pause that cools early waits out the full 60 s', () => {
  const p = createCadencePolicy();
  p.update(Object.assign({}, base, { t: 0, facePresent: true, thermal: 'critical' }));
  let r = p.update(Object.assign({}, base, { t: 10, facePresent: true, thermal: 'fair' }));
  assert.strictEqual(r.paused, true, 'retried every 60 s, not immediately');
  r = p.update(Object.assign({}, base, { t: 61, facePresent: true, thermal: 'fair' }));
  assert.strictEqual(r.paused, false);
});

test('changed is true only on a transition', () => {
  const p = createCadencePolicy();
  assert.strictEqual(p.update(Object.assign({}, base, { t: 0, facePresent: true })).changed, true);
  assert.strictEqual(p.update(Object.assign({}, base, { t: 1, facePresent: true })).changed, false);
  assert.strictEqual(p.update(Object.assign({}, base, { t: 2, facePresent: true, lowPower: true })).changed, true);
});

test('the decision carries the no-face CONDITION, not just the winning reason', () => {
  const p = createCadencePolicy();
  const first = p.update(Object.assign({ t: 0, facePresent: true }, base));
  assert.strictEqual(first.noFace, false);

  // hot AND no face: 'thermal' names the pill, but the camera must still go idle
  const hot = p.update(Object.assign({ t: 20, facePresent: false }, base, { thermal: 'serious' }));
  assert.strictEqual(hot.noFace, true);
  assert.strictEqual(hot.reason, 'thermal');
  assert.strictEqual(hot.targetFps, 5, 'the lowest rate wins');

  // the face returns: the condition clears and the change is reported
  const back = p.update(Object.assign({ t: 21, facePresent: true }, base, { thermal: 'serious' }));
  assert.strictEqual(back.noFace, false);
  assert.strictEqual(back.changed, true);
});
