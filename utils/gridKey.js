// The speed-limit cache cell, shared by the phone and the Cloud Function.
//
// The client (utils/speedLimits.js) and the server (functions/lib/here.js) BOTH key their
// speed-limit caches by this grid. If the two ever disagreed, the phone would ask for a cell the
// server had already cached under a different key - a silent doubling of HERE requests that no
// test would catch. The function cannot import this file (it is deployed on its own, with only
// functions/ uploaded), so it keeps its own copy and
// hooks/__tests__/gridKey.test.js asserts the two agree on a sample of coordinates.
//
// CommonJS and import-free on purpose: the background location task and `node --test` both load
// it outside the React Native runtime.
'use strict';

// ~55 m: narrower than the gap between parallel streets in almost every grid, so one road's
// answer is not served for the road beside it.
const GRID_RESOLUTION = 0.0005;

function gridKey(lat, lon) {
  return `${Math.round(lat / GRID_RESOLUTION)}_${Math.round(lon / GRID_RESOLUTION)}`;
}

module.exports = { GRID_RESOLUTION, gridKey };
