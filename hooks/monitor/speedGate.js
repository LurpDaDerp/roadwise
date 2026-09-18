'use strict';
/**
 * Vehicle speed for the rule engine, from the app's GPS fixes (DETECTION_DESIGN §8).
 *
 *   kmh      = max(0, coords.speed) * 3.6, exponentially smoothed with a 2 s time constant
 *   unknown  = null when the last fix with a speed is older than `staleS` (rules stay fully
 *              active, the reference behaviour)
 *   moving   = true from `moveKmh`; stationary only after `stopKmh` for `stopHoldS` seconds,
 *              so a crawl at 8-12 km/h in traffic does not flap the speed gate.  While
 *              "moving" is held the monitor receives at least `moveKmh` (the held value).
 *
 * Pure and device free: the caller passes the clock.  `node --test` covers it.
 *
 * A fix whose speed is null / not finite / negative counts as "no speed" (iOS reports -1
 * when the speed is unknown); it does not refresh the staleness clock.
 */

const DEFAULTS = {
  emaTauS: 2.0,     // GPS speed at 1 Hz jitters by +-1-2 km/h
  staleS: 10.0,     // older than this -> unknown
  moveKmh: 10.0,    // alerts.speed_gate_kmh
  stopKmh: 5.0,
  stopHoldS: 3.0,
};

const MPS_TO_KMH = 3.6;

function createSpeedGate(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  let ema = null;
  let lastFixS = null;     // time of the last fix that carried a usable speed
  let lastEmaS = null;
  let moving = false;
  let belowSince = null;

  function reset() {
    ema = null;
    lastFixS = null;
    lastEmaS = null;
    moving = false;
    belowSince = null;
  }

  /** A GPS fix in m/s (expo-location `coords.speed`). */
  function onFixMps(nowS, speedMps) {
    if (!Number.isFinite(nowS)) return;
    if (speedMps === null || speedMps === undefined || !Number.isFinite(speedMps) || speedMps < 0) return;
    onFixKmh(nowS, Math.max(0, speedMps) * MPS_TO_KMH);
  }

  /** A GPS fix already converted to km/h. */
  function onFixKmh(nowS, kmh) {
    if (!Number.isFinite(nowS)) return;
    if (kmh === null || kmh === undefined || !Number.isFinite(kmh) || kmh < 0) return;
    const value = Math.max(0, kmh);
    if (ema === null || lastEmaS === null || nowS <= lastEmaS) {
      ema = value;
    } else {
      const dt = nowS - lastEmaS;
      const alpha = 1 - Math.exp(-dt / Math.max(1e-6, cfg.emaTauS));
      ema = ema + alpha * (value - ema);
    }
    lastEmaS = nowS;
    lastFixS = nowS;
  }

  /**
   * The value handed to `monitor.setVehicleSpeed()`.
   * @returns {{kmh: number|null, moving: boolean, ema: number|null, stale: boolean}}
   */
  function read(nowS) {
    const stale = lastFixS === null || !Number.isFinite(nowS) || nowS - lastFixS > cfg.staleS;
    if (stale || ema === null) {
      return { kmh: null, moving, ema, stale: true };
    }
    if (ema >= cfg.moveKmh) {
      moving = true;
      belowSince = null;
    } else if (ema < cfg.stopKmh) {
      if (belowSince === null) belowSince = nowS;
      if (nowS - belowSince >= cfg.stopHoldS) moving = false;
    } else {
      // between stopKmh and moveKmh: hold the current state
      belowSince = null;
    }
    const kmh = moving ? Math.max(ema, cfg.moveKmh) : ema;
    return { kmh, moving, ema, stale: false };
  }

  return { onFixMps, onFixKmh, read, reset, config: cfg };
}

module.exports = { createSpeedGate, DEFAULTS, MPS_TO_KMH };
