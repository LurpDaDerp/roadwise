'use strict';
/** `dms/gaze_inputs.js` against the Python `dms/gaze_inputs.py` fixtures. */

const test = require('node:test');
const assert = require('node:assert');

const { NUM_LANDMARKS, weak3dCloud } = require('../gaze_inputs');
const { loadFixture } = require('./helpers');
const { checkGazeInputs, checkStatsTracker } = require('./parity');

const FX = loadFixture('gaze_inputs_cases');
const PERM = loadFixture('mirror_permutation_478');

test('the mirror permutation is a 478-point involution', () => {
  assert.strictEqual(PERM.length, NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) assert.strictEqual(PERM[PERM[i]], i);
});

test('weak3d cloud, camera context, validity and the eye statistics match the reference', () => {
  checkGazeInputs().assert(assert.ok);
});

test('SubjectStatisticTracker matches the reference (warm-up then running median)', () => {
  checkStatsTracker().assert(assert.ok);
});

test('landmarks are accepted flat and as triples', () => {
  const c = FX.cases[0];
  const flat = [];
  for (const p of c.landmarks) flat.push(p[0], p[1], p[2]);
  const a = weak3dCloud(c.landmarks, c.width, c.height);
  const b = weak3dCloud(Float64Array.from(flat), c.width, c.height);
  for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i]);
  assert.throws(() => weak3dCloud(flat.slice(0, 30), c.width, c.height), /478/);
});

test('the ONNX parity case loads with the shapes the runtime needs', () => {
  const fx = loadFixture('onnx_parity');
  const batch = fx.shapes.cloud[0];
  assert.deepStrictEqual(fx.shapes.cloud, [batch, NUM_LANDMARKS, 3]);
  assert.deepStrictEqual(fx.shapes.context, [batch, 7]);
  assert.deepStrictEqual(fx.shapes.validity, [batch, NUM_LANDMARKS]);
  assert.deepStrictEqual(fx.shapes.gaze, [batch, 3]);
  assert.strictEqual(fx.cloud.length, batch * NUM_LANDMARKS * 3);
  assert.strictEqual(fx.gaze.length, batch * 3);
  assert.strictEqual(fx.rotation.length, batch * 9);
  for (const v of fx.cloud) assert.ok(Number.isFinite(v));
  for (let b = 0; b < batch; b++) {
    const norm = Math.hypot(fx.gaze[b * 3], fx.gaze[b * 3 + 1], fx.gaze[b * 3 + 2]);
    assert.ok(norm > 0.5 && norm < 2.0, `gaze norm ${norm}`);
    for (const v of fx.validity.slice(b * NUM_LANDMARKS, (b + 1) * NUM_LANDMARKS)) {
      assert.ok(v === 0 || v === 1, `validity ${v}`);
    }
  }
});
