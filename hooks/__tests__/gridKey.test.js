// The phone and the Cloud Function key their speed-limit caches by the same grid cell. Two
// copies of the formula exist because the function is deployed on its own (only functions/ is
// uploaded), and a disagreement would be invisible: the phone would simply miss on every cell
// the server had already cached and ask HERE again, doubling the request volume and the bill.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const client = require(path.join(__dirname, '..', '..', 'utils', 'gridKey.js'));
const server = require(path.join(__dirname, '..', '..', 'functions', 'lib', 'here.js'));

test('the client and the Cloud Function agree on the speed-limit grid cell', () => {
  assert.strictEqual(typeof client.gridKey, 'function');
  assert.strictEqual(typeof server.gridKey, 'function');

  // A deterministic spread: both hemispheres, the equator, the poles' edge, the date line,
  // exact cell boundaries and values that round half-to-even differently if the formula drifts.
  const samples = [
    [0, 0], [37.422, -122.084], [-33.8688, 151.2093], [51.5074, -0.1278],
    [-0.00025, 0.00025], [0.00025, -0.00025], [89.9999, 179.9999], [-89.9999, -179.9999],
    [37.1234, -122.5678], [45.00075, -93.00075], [1e-9, -1e-9],
  ];
  let seed = 20260918;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 500; i += 1) {
    samples.push([rand() * 180 - 90, rand() * 360 - 180]);
  }

  for (const [lat, lon] of samples) {
    assert.strictEqual(
      client.gridKey(lat, lon),
      server.gridKey(lat, lon),
      `grid cell disagreement at ${lat}, ${lon}`
    );
  }
});
