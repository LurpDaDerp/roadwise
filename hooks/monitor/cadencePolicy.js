'use strict';
/**
 * Camera cadence and thermal policy (DETECTION_DESIGN §3), as a pure state machine so it can be
 * tested without a device.  One `update(snapshot)` per tick; the hook applies the result with
 * `DmsVision.setTargetFps()` / `setIdleMode()` / `stop()` / `start()`.
 *
 *   full      20 fps   normal monitoring
 *   reduced   10 fps   thermal serious, Low Power Mode, battery < 15 % and not charging,
 *                      or stationary for more than 30 s
 *   idle       5 fps   no face for more than 5 s
 *   paused     0 fps   thermal critical; retried every 60 s once the state is back to fair
 *
 * When several throttles apply the LOWEST frame rate wins and `reason` names the most
 * informative cause (thermal / power before the traffic states), which is what the status pill
 * shows.
 */

const DEFAULTS = {
  fullFps: 20,
  reducedFps: 10,
  idleFps: 5,
  noFaceS: 5.0,
  stationaryS: 30.0,
  thermalRetryS: 60.0,
  lowBatteryLevel: 0.15,
};

/** iOS `ProcessInfo.thermalState` and Android `PowerManager` levels -> one vocabulary. */
function normalizeThermal(raw) {
  if (raw === null || raw === undefined) return 'nominal';
  const s = String(raw).toLowerCase();
  if (s === 'critical' || s === 'shutdown' || s === 'emergency') return 'critical';
  if (s === 'serious' || s === 'severe') return 'serious';
  if (s === 'fair' || s === 'moderate' || s === 'light') return 'fair';
  return 'nominal';
}

const REASON_RANK = {
  thermalPause: 0,
  thermal: 1,
  lowPower: 2,
  lowBattery: 3,
  noFace: 4,
  stationary: 5,
  full: 6,
};

function createCadencePolicy(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  let lastFaceS = null;
  let stationarySince = null;
  let pausedSince = null;
  let paused = false;
  let last = null;          // last emitted { targetFps, paused, reason }

  function reset() {
    lastFaceS = null;
    stationarySince = null;
    pausedSince = null;
    paused = false;
    last = null;
  }

  /** Call on every processed frame (or whenever face presence is known). */
  function noteFace(nowS, facePresent) {
    if (facePresent) lastFaceS = nowS;
    else if (lastFaceS === null) lastFaceS = nowS;   // start the clock at the first frame
  }

  /**
   * @param {object} s
   *   t             seconds (wall clock; frames stop arriving while paused)
   *   facePresent   boolean, optional - same as calling noteFace()
   *   moving        boolean|null - null / true means "not known to be stationary"
   *   thermal       'nominal' | 'fair' | 'serious' | 'critical' (or the platform spelling)
   *   lowPower      boolean
   *   batteryLevel  0..1 or null
   *   batteryCharging boolean|null
   * @returns {{targetFps:number, paused:boolean, reason:string, changed:boolean,
   *            thermal:string, resume:boolean}}
   */
  function update(s) {
    const t = Number.isFinite(s.t) ? s.t : 0;
    if (s.facePresent !== undefined && s.facePresent !== null) noteFace(t, Boolean(s.facePresent));

    const thermal = normalizeThermal(s.thermal);

    // --- thermal pause and its 60 s retry -------------------------------------------------
    let resume = false;
    if (thermal === 'critical') {
      if (!paused) pausedSince = t;
      paused = true;
    } else if (paused) {
      const cooled = thermal === 'nominal' || thermal === 'fair';
      if (cooled && pausedSince !== null && t - pausedSince >= cfg.thermalRetryS) {
        paused = false;
        pausedSince = null;
        resume = true;
      }
    }

    // --- stationary clock ------------------------------------------------------------------
    if (s.moving === false) {
      if (stationarySince === null) stationarySince = t;
    } else {
      stationarySince = null;
    }

    // Every applicable throttle contributes a rate; the LOWEST rate is applied and the
    // best-ranked reason (thermal / power before the traffic states) names the pill.
    let targetFps = cfg.fullFps;
    let reason = 'full';
    const consider = (fps, why) => {
      if (fps < targetFps) targetFps = fps;
      if (REASON_RANK[why] < REASON_RANK[reason]) reason = why;
    };

    if (thermal === 'serious') consider(cfg.reducedFps, 'thermal');
    if (s.lowPower) consider(cfg.reducedFps, 'lowPower');
    if (Number.isFinite(s.batteryLevel) && s.batteryLevel < cfg.lowBatteryLevel && s.batteryCharging !== true) {
      consider(cfg.reducedFps, 'lowBattery');
    }
    if (stationarySince !== null && t - stationarySince > cfg.stationaryS) consider(cfg.reducedFps, 'stationary');
    if (lastFaceS !== null && t - lastFaceS > cfg.noFaceS) consider(cfg.idleFps, 'noFace');

    if (paused) {
      targetFps = 0;
      reason = 'thermalPause';
    }

    const out = { targetFps, paused, reason, thermal, resume };
    const changed = last === null || last.targetFps !== targetFps || last.paused !== paused || last.reason !== reason;
    last = { targetFps, paused, reason };
    out.changed = changed;
    return out;
  }

  return { update, noteFace, reset, config: cfg };
}

module.exports = { createCadencePolicy, normalizeThermal, DEFAULTS };
