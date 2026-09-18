'use strict';
/** `dms/drowsiness.js` against the reference tracker on the `tools/synth_streams.py` streams. */

const test = require('node:test');
const assert = require('node:assert');

const { loadFixture, listFixtures } = require('./helpers');
const { replayDrowsinessFixture } = require('./replay');

for (const file of listFixtures('drowsiness_')) {
  test(`drowsiness parity: ${file.replace(/^drowsiness_|\.json$/g, '')}`, () => {
    const fx = loadFixture(file);
    const cmp = replayDrowsinessFixture(fx);
    cmp.assert(assert.ok);
    assert.strictEqual(cmp.eventsMatched, cmp.eventsExpected);
    assert.ok(cmp.maxDiff < 1e-6, `max abs diff ${cmp.maxDiff}`);
  });
}
