'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { emptyFrameMeta, decideFrameMeta, adoptFrameMeta } = require('../monitor/frameMeta');

test('nothing is known until a frame says so', () => {
  const meta = emptyFrameMeta();
  assert.strictEqual(meta.focalScale, null);
  assert.strictEqual(meta.isMirrored, null);
  assert.strictEqual(meta.orientation, null);
  const d = decideFrameMeta(meta, {});
  assert.strictEqual(d.focalScale, null);
  assert.strictEqual(d.isMirrored, null);
  assert.strictEqual(d.rebuild, false);
});

test('the first usable focal scale and mirror flag are adopted and rebuild the engine', () => {
  const meta = emptyFrameMeta();
  const d = adoptFrameMeta(meta, { focalScale: 0.9, isMirrored: false, orientation: 'portrait', intrinsicsSource: 'fov' });
  assert.strictEqual(d.focalScale, 0.9);
  assert.strictEqual(d.isMirrored, false);
  assert.strictEqual(d.rebuild, true);
  assert.strictEqual(d.firstOrientation, true);
  assert.strictEqual(d.orientationChanged, true);
  assert.strictEqual(meta.focalScale, 0.9);
  assert.strictEqual(meta.intrinsicsSource, 'fov');
});

test('a placeholder focal scale of 0 or null is never latched', () => {
  const meta = emptyFrameMeta();
  adoptFrameMeta(meta, { focalScale: 0, isMirrored: null });           // the iOS placeholder
  assert.strictEqual(meta.focalScale, null, '0 is not a usable focal scale');
  assert.strictEqual(meta.isMirrored, null);
  const d = adoptFrameMeta(meta, { focalScale: 0.88, isMirrored: true });
  assert.strictEqual(d.rebuild, true);
  assert.strictEqual(meta.focalScale, 0.88);
  assert.strictEqual(meta.isMirrored, true);
});

test('a focal scale within 1 % is noise; beyond it the engine is rebuilt', () => {
  const meta = emptyFrameMeta();
  adoptFrameMeta(meta, { focalScale: 0.900 });
  const same = adoptFrameMeta(meta, { focalScale: 0.9005 });
  assert.strictEqual(same.focalChanged, false);
  assert.strictEqual(same.rebuild, false);
  assert.strictEqual(meta.focalScale, 0.900, 'the cached value is kept');
  const moved = adoptFrameMeta(meta, { focalScale: 0.95 });
  assert.strictEqual(moved.focalChanged, true);
  assert.strictEqual(meta.focalScale, 0.95);
});

test('a mirror flag that disagrees with the cache is adopted (the zones depend on it)', () => {
  const meta = emptyFrameMeta();
  adoptFrameMeta(meta, { isMirrored: false });
  const again = adoptFrameMeta(meta, { isMirrored: false });
  assert.strictEqual(again.mirrorChanged, false);
  const flipped = adoptFrameMeta(meta, { isMirrored: true });
  assert.strictEqual(flipped.mirrorChanged, true);
  assert.strictEqual(flipped.rebuild, true);
  assert.strictEqual(meta.isMirrored, true);
});

test('an orientation change is reported but does not rebuild the engine', () => {
  const meta = emptyFrameMeta();
  adoptFrameMeta(meta, { orientation: 'portrait', focalScale: 0.9, isMirrored: false });
  const turned = adoptFrameMeta(meta, { orientation: 'landscapeLeft', focalScale: 0.9, isMirrored: false });
  assert.strictEqual(turned.orientationChanged, true);
  assert.strictEqual(turned.firstOrientation, false);
  assert.strictEqual(turned.rebuild, false, 'the mount moved; the camera did not change');
  assert.strictEqual(meta.orientation, 'landscapeLeft');
});
