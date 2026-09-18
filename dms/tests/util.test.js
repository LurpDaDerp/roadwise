'use strict';
/** `dms/util.js` against the Python `dms/util.py` fixtures. */

const test = require('node:test');
const assert = require('node:assert');

const {
  BucketWindowSum, CausalMedian, DecayingHistogram1D, DecayingHistogram2D, Deque, EventCounter,
  TimeWindowSum, pairwiseSum, pyMod, pyRound, roundHalfEven, wrapDeg,
} = require('../util');
const { loadFixture, Cmp } = require('./helpers');
const {
  checkHist1d, checkHist2d, checkWindows, checkAngles, checkEventRounding,
} = require('./parity');

const FX = loadFixture('util_cases');

test('DecayingHistogram1D matches the reference', () => {
  const cmp = new Cmp('util.hist1d');
  checkHist1d(FX, 'hist1d', cmp);
  checkHist1d(FX, 'hist1d_decay', cmp);
  cmp.assert(assert.ok);
});

test('DecayingHistogram2D, smoothed, mode, mass_within and robust_mode match', () => {
  const cmp = new Cmp('util.hist2d');
  checkHist2d(FX, cmp);
  cmp.assert(assert.ok);
});

test('CausalMedian, TimeWindowSum, BucketWindowSum and EventCounter match', () => {
  const cmp = new Cmp('util.windows');
  checkWindows(FX, cmp);
  cmp.assert(assert.ok);
});

test('angle helpers match the reference', () => {
  const cmp = new Cmp('util.angles');
  checkAngles(FX, cmp);
  cmp.assert(assert.ok);
});

test('Event.toDict rounds exactly like Python round()', () => {
  const cmp = new Cmp('util.event_rounding');
  checkEventRounding(FX, cmp);
  cmp.assert(assert.ok);
});

test('pyRound is round-half-to-even on the exact binary value', () => {
  assert.strictEqual(pyRound(0.0625, 3), 0.062);     // exact tie -> even
  assert.strictEqual(pyRound(0.1875, 3), 0.188);     // exact tie -> even
  assert.strictEqual(pyRound(2.675, 2), 2.67);       // 2.675 is below the tie in binary
  assert.strictEqual(pyRound(-0.0625, 3), -0.062);
  assert.strictEqual(pyRound(1.0005, 3), 1.0);       // below the tie in binary
  assert.strictEqual(pyRound(123.4565, 3), 123.457);   // above the tie in binary
  assert.strictEqual(pyRound(1 / 3, 4), 0.3333);
  assert.ok(Number.isNaN(pyRound(NaN, 3)));
  assert.strictEqual(pyRound(Infinity, 3), Infinity);
  assert.strictEqual(roundHalfEven(2.5), 2);
  assert.strictEqual(roundHalfEven(3.5), 4);
  assert.strictEqual(roundHalfEven(-2.5), -2);
});

test('pyMod and wrapDeg follow Python semantics', () => {
  assert.strictEqual(pyMod(-1.0, 360.0), 359.0);
  assert.strictEqual(pyMod(370.0, 360.0), 10.0);
  assert.strictEqual(wrapDeg(190.0), -170.0);
  assert.strictEqual(wrapDeg(-190.0), 170.0);
  assert.strictEqual(wrapDeg(180.0), -180.0);
});

test('pairwiseSum reproduces numpy blocking and stays accurate', () => {
  const a = new Float64Array(1000).fill(0.1);
  assert.ok(Math.abs(pairwiseSum(a, 0, a.length) - 100.0) < 1e-12);
  const b = [1, 2, 3, 4, 5, 6, 7];
  assert.strictEqual(pairwiseSum(b, 0, b.length), 28);
  const c = new Float64Array(9).fill(1);
  assert.strictEqual(pairwiseSum(c, 0, 9), 9);
});

test('Deque behaves like collections.deque(maxlen=...)', () => {
  const d = new Deque(3);
  [1, 2, 3, 4, 5].forEach((v) => d.push(v));
  assert.deepStrictEqual(d.toArray(), [3, 4, 5]);
  assert.strictEqual(d.first(), 3);
  assert.strictEqual(d.last(), 5);
  assert.strictEqual(d.length, 3);
  d.shift();
  assert.deepStrictEqual(d.toArray(), [4, 5]);
  d.clear();
  assert.strictEqual(d.length, 0);
});

test('the histograms bin, clamp and renormalise like the reference', () => {
  const h = new DecayingHistogram1D(-0.2, 0.6, 0.0025, 30.0);
  assert.strictEqual(h.n, 320);
  h.add(-5.0, 0.0, 1.0);                 // clamped into bin 0
  h.add(5.0, 0.0, 1.0);                  // clamped into the last bin
  h.add(NaN, 0.0, 1.0);                  // ignored
  h.add(0.1, 0.0, 0.0);                  // w <= 0 ignored
  assert.ok(Math.abs(h.mass() - 2.0) < 1e-12);
  assert.strictEqual(new DecayingHistogram1D(0, 1, 2, 10).n, 1);   // never zero bins
  const g = new DecayingHistogram2D([-70, 70], [-50, 50], 1.0, 300.0);
  assert.strictEqual(g.nx, 140);
  assert.strictEqual(g.ny, 100);
  assert.strictEqual(g.mode(1.5), null);          // empty
  assert.strictEqual(g.mass(), 0);
  const cm = new CausalMedian(4);
  assert.strictEqual(cm.push(1), 1);
  assert.strictEqual(cm.push(3), 2);               // even -> mean of the middle two
  const tw = new TimeWindowSum(1.0);
  tw.push(0.0, -5.0, 1.0);
  assert.strictEqual(tw.total(0.0), 0.0);          // clamped
  assert.strictEqual(tw.total(0.0, false), -5.0);  // signed
  const bw = new BucketWindowSum(10.0, 1.0);
  bw.push(-0.5, 1.0, 1.0);                         // negative keys use Python's floor/modulo
  assert.deepStrictEqual(bw.totals(0.0), [1.0, 1.0]);
  const ec = new EventCounter(5.0);
  ec.push(0.0);
  ec.push(1.0);
  assert.strictEqual(ec.count(1.0), 2);
  assert.strictEqual(ec.count(10.0), 0);
});
