'use strict';
/** `dms/features.js` against the Python `dms/features.py` fixtures. */

const test = require('node:test');
const assert = require('node:assert');

const { emptyFeatures, headAngles, headTurnDeg } = require('../features');
const { isNullish } = require('./helpers');
const { checkFeatures } = require('./parity');

test('computeFeatures matches the reference on random faces', () => {
  checkFeatures().assert(assert.ok);
});

test('headAngles signs follow the stored convention', () => {
  const rad = (d) => (d * Math.PI) / 180;
  const rotZ = (d) => [Math.cos(rad(d)), -Math.sin(rad(d)), 0, Math.sin(rad(d)), Math.cos(rad(d)), 0, 0, 0, 1];
  const rotY = (d) => [Math.cos(rad(d)), 0, Math.sin(rad(d)), 0, 1, 0, -Math.sin(rad(d)), 0, Math.cos(rad(d))];
  const rotX = (d) => [1, 0, 0, 0, Math.cos(rad(d)), -Math.sin(rad(d)), 0, Math.sin(rad(d)), Math.cos(rad(d))];
  let h = headAngles([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.ok(Math.abs(h.yaw) < 1e-12 && Math.abs(h.pitch) < 1e-12 && Math.abs(h.roll) < 1e-12);
  assert.ok(Math.abs(h.dir[2] - 1.0) < 1e-12);
  assert.ok(Math.abs(headAngles(rotZ(10)).roll - 10.0) < 1e-9);
  assert.ok(Math.abs(headAngles(rotZ(-25)).roll + 25.0) < 1e-9);
  h = headAngles(rotY(20));
  assert.ok(Math.abs(Math.abs(h.yaw) - 20.0) < 1e-9 && Math.abs(h.pitch) < 1e-9 && Math.abs(h.roll) < 1e-9);
  h = headAngles(rotX(15));
  assert.ok(Math.abs(Math.abs(h.pitch) - 15.0) < 1e-9 && Math.abs(h.yaw) < 1e-9 && Math.abs(h.roll) < 1e-9);
  assert.strictEqual(headAngles([[1, 0, 0], [0, 1, 0], [0, 0, 1]]).roll, 0);   // nested 3x3 accepted
});

test('emptyFeatures and headTurnDeg behave like the reference', () => {
  const e = emptyFeatures(3.0);
  assert.strictEqual(e.face_present, false);
  assert.ok(isNullish(e.ear));
  assert.strictEqual(e.head_dir, null);
  assert.strictEqual(headTurnDeg(e, [0, 0, 1]), null);
  e.head_dir = [0, 0, 1];
  assert.ok(Math.abs(headTurnDeg(e, [0, 0, 1])) < 1e-12);
  assert.ok(Math.abs(headTurnDeg(e, [1, 0, 0]) - 90.0) < 1e-12);
  assert.strictEqual(headTurnDeg(e, null), null);
});
