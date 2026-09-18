'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createSpeedGate } = require('../monitor/speedGate');

test('no fix yet -> unknown speed (rules stay fully active)', () => {
  const g = createSpeedGate();
  const r = g.read(0);
  assert.strictEqual(r.kmh, null);
  assert.strictEqual(r.stale, true);
});

test('a fix in m/s becomes km/h and the first fix sets the EMA exactly', () => {
  const g = createSpeedGate();
  g.onFixMps(0, 10);                 // 36 km/h
  const r = g.read(0);
  assert.ok(Math.abs(r.ema - 36) < 1e-9);
  assert.strictEqual(r.moving, true);
  assert.ok(Math.abs(r.kmh - 36) < 1e-9);
});

test('a fix without a usable speed does not refresh the clock', () => {
  const g = createSpeedGate();
  g.onFixMps(0, 10);
  g.onFixMps(5, -1);                 // iOS "unknown speed" sentinel
  g.onFixMps(8, null);
  assert.strictEqual(g.read(9).stale, false);
  assert.strictEqual(g.read(11).kmh, null, 'stale after 10 s without a speed fix');
});

test('the 2 s EMA smooths GPS jitter', () => {
  const g = createSpeedGate();
  g.onFixKmh(0, 50);
  g.onFixKmh(1, 54);                 // a +4 km/h jump
  const r = g.read(1);
  // alpha = 1 - exp(-1/2) = 0.3935 -> 50 + 0.3935*4 = 51.57
  assert.ok(r.ema > 51.4 && r.ema < 51.8, `ema ${r.ema}`);
});

test('moving from 10 km/h, stationary only after 3 s below 5 km/h', () => {
  const g = createSpeedGate();
  for (let t = 0; t <= 10; t++) g.onFixKmh(t, 60);
  assert.strictEqual(g.read(10).moving, true);

  // hard stop: the EMA needs a few seconds to fall below 5
  for (let t = 11; t <= 30; t++) g.onFixKmh(t, 0);
  const atStop = g.read(30);
  assert.ok(atStop.ema < 5, `ema ${atStop.ema}`);
  // the first read below 5 starts the 3 s hold, so it is still "moving"
  assert.strictEqual(atStop.moving, true);
  g.onFixKmh(32, 0);
  assert.strictEqual(g.read(32).moving, true, 'still held at 2 s');
  g.onFixKmh(33.5, 0);
  assert.strictEqual(g.read(33.5).moving, false, 'stationary after 3 s');
  assert.ok(g.read(33.5).kmh < 5);
});

test('a crawl between 5 and 10 km/h holds the current state (no flapping)', () => {
  const g = createSpeedGate();
  for (let t = 0; t <= 20; t++) g.onFixKmh(t, 30);
  assert.strictEqual(g.read(20).moving, true);
  for (let t = 21; t <= 40; t++) g.onFixKmh(t, 8);   // stuck in traffic at 8 km/h
  const r = g.read(40);
  assert.ok(r.ema > 5 && r.ema < 10, `ema ${r.ema}`);
  assert.strictEqual(r.moving, true, 'still moving');
  assert.ok(Math.abs(r.kmh - 10) < 1e-9, 'the monitor receives the held value of 10 km/h');
});

test('the held value is at least the speed gate while moving', () => {
  const g = createSpeedGate();
  g.onFixKmh(0, 60);
  for (let t = 1; t <= 6; t++) g.onFixKmh(t, 9);
  const r = g.read(6);
  assert.strictEqual(r.moving, true);
  assert.ok(r.kmh >= 10);
});

test('stationary from the start stays stationary and reports the raw EMA', () => {
  const g = createSpeedGate();
  for (let t = 0; t <= 10; t += 1) g.onFixKmh(t, 0);
  const r = g.read(10);
  assert.strictEqual(r.moving, false);
  assert.strictEqual(r.kmh, 0);
});

test('staleness returns unknown but the hysteresis survives a resumed fix', () => {
  const g = createSpeedGate();
  for (let t = 0; t <= 10; t++) g.onFixKmh(t, 60);
  assert.strictEqual(g.read(25).kmh, null);
  g.onFixKmh(26, 60);
  assert.strictEqual(g.read(26).moving, true);
});

test('reset clears everything', () => {
  const g = createSpeedGate();
  g.onFixKmh(0, 60);
  g.reset();
  assert.strictEqual(g.read(0).kmh, null);
});
