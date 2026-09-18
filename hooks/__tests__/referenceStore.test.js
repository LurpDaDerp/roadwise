'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  referenceKey,
  serializeReference,
  parseReference,
  loadReference,
  saveReference,
  clearReference,
  VERSION,
} = require('../monitor/referenceStore');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k) { return map.has(k) ? map.get(k) : null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
  };
}

const NOW = Date.UTC(2026, 8, 18) ;
const REF = [0.05, -0.02, 0.998];

test('the key is per camera facing and device orientation', () => {
  assert.strictEqual(referenceKey('front', 'portrait'), '@monitorReference:front:portrait');
  assert.strictEqual(referenceKey(null, null), '@monitorReference:front:unknown');
});

test('a CONFIRMED reference round-trips', () => {
  const json = serializeReference({
    reference: REF, headMode: [2.5, -3.0], facing: 'front', orientation: 'portrait',
    modelSha: 'abc123', focalScale: 0.9, savedAtMs: NOW,
  });
  const parsed = parseReference(json, { nowMs: NOW + 1000, modelSha: 'abc123', facing: 'front', orientation: 'portrait' });
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.value.reference, REF);
  assert.deepStrictEqual(parsed.value.headMode, [2.5, -3.0]);
  assert.strictEqual(parsed.value.focalScale, 0.9);
  assert.strictEqual(JSON.parse(json).v, VERSION);
});

test('a non-finite or zero reference is not storable', () => {
  assert.strictEqual(serializeReference({ reference: [0, 0, 0] }), null);
  assert.strictEqual(serializeReference({ reference: [NaN, 0, 1] }), null);
  assert.strictEqual(serializeReference({ reference: [1, 2] }), null);
  assert.strictEqual(serializeReference({}), null);
});

test('garbage and a wrong version are rejected, not thrown', () => {
  assert.strictEqual(parseReference('not json', { nowMs: NOW }).reason, 'corrupt');
  assert.strictEqual(parseReference(null, { nowMs: NOW }).reason, 'empty');
  assert.strictEqual(parseReference(JSON.stringify({ v: 99, reference: REF, savedAt: NOW }), { nowMs: NOW }).reason, 'version');
});

test('the prior expires after 30 days', () => {
  const json = serializeReference({ reference: REF, savedAtMs: NOW });
  assert.strictEqual(parseReference(json, { nowMs: NOW + 29 * 86400000 }).ok, true);
  assert.strictEqual(parseReference(json, { nowMs: NOW + 31 * 86400000 }).reason, 'expired');
});

test('a clock that moved backwards is treated as expired', () => {
  const json = serializeReference({ reference: REF, savedAtMs: NOW });
  assert.strictEqual(parseReference(json, { nowMs: NOW - 5 * 86400000 }).reason, 'expired');
});

test('a different model bundle drops the prior', () => {
  const json = serializeReference({ reference: REF, savedAtMs: NOW, modelSha: 'old' });
  assert.strictEqual(parseReference(json, { nowMs: NOW, modelSha: 'new' }).reason, 'model');
  assert.strictEqual(parseReference(json, { nowMs: NOW, modelSha: 'old' }).ok, true);
  assert.strictEqual(parseReference(json, { nowMs: NOW }).ok, true, 'unknown sha does not invalidate');
});

test('a different facing or orientation drops the prior', () => {
  const json = serializeReference({ reference: REF, savedAtMs: NOW, facing: 'front', orientation: 'portrait' });
  assert.strictEqual(parseReference(json, { nowMs: NOW, orientation: 'landscapeLeft' }).reason, 'mount');
  assert.strictEqual(parseReference(json, { nowMs: NOW, facing: 'back' }).reason, 'mount');
});

test('save then load through an injected storage', async () => {
  const storage = fakeStorage();
  const ok = await saveReference(storage, {
    reference: REF, headMode: [1, 2], facing: 'front', orientation: 'portrait',
    modelSha: 'sha', focalScale: 0.9, savedAtMs: NOW,
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(storage.map.size, 1);
  const loaded = await loadReference(storage, { facing: 'front', orientation: 'portrait', nowMs: NOW + 5000, modelSha: 'sha' });
  assert.strictEqual(loaded.ok, true);
  assert.deepStrictEqual(loaded.value.reference, REF);
});

test('loading an invalid prior removes it from storage', async () => {
  const storage = fakeStorage({ '@monitorReference:front:portrait': 'broken' });
  const loaded = await loadReference(storage, { facing: 'front', orientation: 'portrait', nowMs: NOW });
  assert.strictEqual(loaded.ok, false);
  assert.strictEqual(storage.map.size, 0);
});

test('a missing prior is not an error and does not remove anything', async () => {
  const storage = fakeStorage();
  const loaded = await loadReference(storage, { facing: 'front', orientation: 'portrait', nowMs: NOW });
  assert.strictEqual(loaded.ok, false);
  assert.strictEqual(loaded.reason, 'empty');
});

test('a throwing storage never throws out of the helpers', async () => {
  const broken = {
    async getItem() { throw new Error('nope'); },
    async setItem() { throw new Error('nope'); },
    async removeItem() { throw new Error('nope'); },
  };
  assert.strictEqual((await loadReference(broken, { nowMs: NOW })).ok, false);
  assert.strictEqual(await saveReference(broken, { reference: REF }), false);
  assert.strictEqual(await clearReference(broken, {}), false);
});

test('clearReference removes only its own key', async () => {
  const storage = fakeStorage();
  await saveReference(storage, { reference: REF, facing: 'front', orientation: 'portrait', savedAtMs: NOW });
  await saveReference(storage, { reference: REF, facing: 'front', orientation: 'landscapeLeft', savedAtMs: NOW });
  await clearReference(storage, { facing: 'front', orientation: 'portrait' });
  assert.strictEqual(storage.map.size, 1);
  assert.ok(storage.map.has('@monitorReference:front:landscapeLeft'));
});
