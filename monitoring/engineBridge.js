'use strict';
/**
 * `MonitoringBridge` — the rule engine (`dms/`) expressed in the app's monitoring contract
 * (`monitoring/types.js`, docs/UX_REWORK.md §5.2).
 *
 * The engine speaks in reference events with its own vocabulary, priorities, cooldowns and speed
 * gate; the UI speaks in ONE live `activeAlert`, a calibration state, a 0-3 drowsiness level and
 * cumulative `metrics`.  This file is the whole translation, and it is PURE: no React, no React
 * Native, no timers of its own.  The hook feeds it one engine output per processed frame and
 * reads a snapshot four times a second; `node --test` drives it with the synthetic driver.
 *
 *   const bridge = new MonitoringBridge({ config, monitor });
 *   bridge.setSession('running');
 *   bridge.update(output);            // output.events / output.voiced are read by default
 *   const { status, calibration, activeAlert, drowsiness, metrics } = bridge.snapshot();
 *
 * Design decisions worth knowing (docs/dms/INTEGRATION.md):
 *  * A WARNING / CRITICAL episode is created ONLY from the arbiter's voiced event, so the
 *    reference's per-type cooldowns, one-audible-at-a-time hold, speed gate and acknowledgement
 *    suppression all apply before the app ever makes a sound.
 *  * An episode is keyed by `${alertType}@${t_start}`, so the arbiter's 2 s escalations and its
 *    1.5 s critical repeats extend the same alert instead of creating new ones or new counts.
 *  * INFO never pre-empts a live WARNING / CRITICAL.
 */

const { EventType, Severity, PRIORITY } = require('../dms/alerts');
const { ALERT_SEVERITY, ALERT_TYPE, CALIBRATION_STATE, MONITOR_STATUS, alertCopy } = require('./types');

// ---------------------------------------------------------------------------- mapping
/** Reference event -> app alert type.  Anything absent is metrics / state only. */
const EVENT_TO_ALERT = {
  [EventType.OFF_ROAD_GLANCE]: ALERT_TYPE.OFF_ROAD_GLANCE,
  [EventType.LONG_GLANCE]: ALERT_TYPE.LONG_GLANCE,
  [EventType.PROLONGED_STARE]: ALERT_TYPE.PROLONGED_STARE,
  [EventType.VATS_DISTRACTION]: ALERT_TYPE.EYES_OFF_ROAD_ACCUMULATED,
  [EventType.PHONE_PATTERN]: ALERT_TYPE.PHONE_GLANCE,
  [EventType.HEAD_DOWN]: ALERT_TYPE.HEAD_DOWN,
  [EventType.HEAD_TURNED]: ALERT_TYPE.HEAD_TURNED,
  [EventType.MICROSLEEP]: ALERT_TYPE.MICROSLEEP,
  [EventType.SLEEP]: ALERT_TYPE.EYES_CLOSED,
  [EventType.EYES_CLOSED]: ALERT_TYPE.EYES_CLOSED,
  [EventType.SEVERE_DROWSY]: ALERT_TYPE.SEVERE_DROWSY,
  [EventType.DROWSY]: ALERT_TYPE.DROWSY,
  [EventType.YAWN]: ALERT_TYPE.YAWNING,
  [EventType.FREQUENT_YAWNING]: ALERT_TYPE.YAWNING,
  [EventType.HEAD_NOD]: ALERT_TYPE.HEAD_NOD,
  [EventType.DRIVER_NOT_VISIBLE]: ALERT_TYPE.NO_FACE,
  [EventType.EYES_UNREADABLE]: ALERT_TYPE.EYES_NOT_VISIBLE,
  [EventType.GAZE_CONCENTRATION]: ALERT_TYPE.FIXED_GAZE,
  [EventType.NO_MIRROR_CHECK]: ALERT_TYPE.NO_MIRROR_CHECK,
  [EventType.PERCLOS_ADVISORY]: ALERT_TYPE.PERCLOS,   // the engine's display-only 8 % hint (INFO)
  // ATTENTION_BUFFER_EMPTY, PROLONGED_CLOSURE, SLOW_BLINKS, BLINK, DROWSINESS_RECOVERED and
  // every calibration / system event are state and metrics only.
};

/** The engine's PERCLOS advisory event name (dms/alerts.js), kept for callers. */
const PERCLOS_ADVISORY_EVENT = EventType.PERCLOS_ADVISORY;

/** Episodes that end on a return to the road. */
const GLANCE_ALERTS = new Set([
  ALERT_TYPE.LONG_GLANCE,
  ALERT_TYPE.PROLONGED_STARE,
  ALERT_TYPE.OFF_ROAD_GLANCE,
  ALERT_TYPE.EYES_OFF_ROAD_ACCUMULATED,
  ALERT_TYPE.PHONE_GLANCE,
  ALERT_TYPE.HEAD_DOWN,
  ALERT_TYPE.HEAD_TURNED,
  ALERT_TYPE.FIXED_GAZE,
]);

/** Episodes that end when the eyes reopen. */
const CLOSURE_ALERTS = new Set([ALERT_TYPE.EYES_CLOSED, ALERT_TYPE.MICROSLEEP]);

/** Episodes that end a fixed time after their last event. */
const LINGERING_ALERTS = new Set([
  ALERT_TYPE.DROWSY,
  ALERT_TYPE.SEVERE_DROWSY,
  ALERT_TYPE.PERCLOS,
  ALERT_TYPE.YAWNING,
  ALERT_TYPE.HEAD_NOD,
]);

/** Attention alerts that hold points and count as a distraction episode (DETECTION §11). */
const DISTRACTION_ALERTS = new Set([
  ALERT_TYPE.LONG_GLANCE,
  ALERT_TYPE.PROLONGED_STARE,
  ALERT_TYPE.EYES_OFF_ROAD_ACCUMULATED,
  ALERT_TYPE.PHONE_GLANCE,
  ALERT_TYPE.HEAD_DOWN,
  ALERT_TYPE.HEAD_TURNED,
]);

/** One of these resets the streak on its own (DETECTION §11). */
const STREAK_BREAKERS = new Set([ALERT_TYPE.PROLONGED_STARE, ALERT_TYPE.EYES_CLOSED]);

// ---------------------------------------------------------------------------- timings
const FORWARD_CLEAR_S = 1.0;      // Euro NCAP: 1 s of continuous forward gaze terminates
const EYES_OPEN_CLEAR_S = 1.0;
const NO_REPEAT_CLEAR_S = 3.0;    // no event of this episode for 3 s
const LINGER_CLEAR_S = 8.0;
const NO_MIRROR_CLEAR_S = 6.0;
const INFO_MIN_S = 4.0;           // an INFO banner stays readable for 4 s
const NO_FACE_STATUS_S = 5.0;
const LOST_AFTER_MOVE_S = 5.0;
const CONFIRM_TARGET_S = 60.0;    // calibration progress denominator
const DROWSINESS_SAMPLE_S = 10.0;
const DROWSINESS_HISTORY_MAX = 120;
const POINTS_HOLD_S = 10.0;
const STREAK_EPISODES = 3;
const MAX_DT_S = 1.0;             // a longer gap is a stopped camera, not monitored time
const EYES_OFF_ALLOWANCE = { cabin: 0.0, lateral: 2.0, driving_task: 1.0 };
const PERCLOS_ADVISORY_DEFAULT = 0.08;
const DROWSY_HINT_SCORE = 25.0;

const SEVERITY_RANK = {
  [ALERT_SEVERITY.INFO]: 1,
  [ALERT_SEVERITY.WARNING]: 2,
  [ALERT_SEVERITY.CRITICAL]: 3,
};

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function num(x, digits = 3, fallback = 0) {
  const v = Number(x);
  if (!Number.isFinite(v)) return fallback;
  const p = Math.pow(10, digits);
  const r = Math.round(v * p) / p;
  return Object.is(r, -0) ? 0 : r;
}

/** Reference severity + audibility -> app severity. */
function severityOf(event, alertType) {
  const s = event && event.severity;
  if (s === Severity.CRITICAL) return ALERT_SEVERITY.CRITICAL;
  const audible = !event || !event.extra || event.extra.audible !== false;
  if (s === Severity.WARNING && audible) return ALERT_SEVERITY.WARNING;
  return ALERT_SEVERITY.INFO;
}

class MonitoringBridge {
  /**
   * @param {object} options
   *   config   a `dms/app_config.js` configuration (for the PERCLOS advisory level)
   *   monitor  the `DriverMonitor` (only for `acknowledge`); may be set later
   *   now      () => ms epoch, injectable for the tests
   */
  constructor(options = {}) {
    this.config = options.config || null;
    this.monitor = options.monitor || null;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.reset();
  }

  setMonitor(monitor) {
    this.monitor = monitor;
  }

  setConfig(config) {
    this.config = config || null;
  }

  reset() {
    this.session = 'off';          // off | starting | running | permission_denied | camera_error
    this.version = 0;              // bumped whenever the snapshot changes

    this.t0 = null;
    this.tLast = null;
    this.lastFaceT = null;
    this.monitoredSeconds = 0;
    this.facePresentSeconds = 0;
    this.eyesReadableSeconds = 0;
    this.calibratedSeconds = 0;
    this.frames = 0;

    this.episodes = new Map();     // id -> episode
    this.activeAlert = null;
    this.acknowledged = new Set();

    this.metrics = {
      eyesOffRoadSeconds: 0,
      alertCounts: { info: 0, warning: 0, critical: 0 },
      alertsByType: {},
      drowsinessPeak: 0,
      drowsinessHistory: [],
      calibrationQuality: null,
    };
    this.drowsiness = { level: 0, perclos: null };

    this.confidence = 'NONE';
    this.calibrationState = CALIBRATION_STATE.OFF;
    this.calibrationProgress = 0;
    this.admittedS = 0;
    this.lostUntilT = null;
    this.timeToProvisionalS = null;
    this.timeToConfirmedS = null;
    this.recalibrations = 0;
    this.staleEvents = 0;
    this.cameraMoved = 0;
    this.driverChange = 0;

    this._forwardSinceT = null;
    this._eyesOpenSinceT = null;
    this._lastHistoryT = null;
    this._advisoryArmed = true;
    this._counted = new Map();     // episode id -> the severity it was counted at
    this._distractionIds = new Set();
    this._distractionEpisodes = 0;
    this._streakBreaker = false;
    this._lastDistractionT = null;
    this._glanceCounts = { driving_task: 0, lateral: 0, cabin: 0 };
    this._inGlance = false;
    this._glanceClass = null;
    this.maxGlanceS = 0;
    this.maxPerclos60 = 0;
    this.maxPerclos180 = 0;
    this.engineEpisodes = {};      // reference EventType -> episodes (diagnostics)
    this._engineStarts = new Map();

    this.detail = {
      fpsMean: 0,
      fpsSamples: 0,
      thermalPauses: 0,
      errors: 0,
      intrinsicsSource: 'default',
      focalScale: null,
      parity: null,
      orientationFault: false,
      seededFromPrior: false,
      permission: 'undetermined',
    };
  }

  // ------------------------------------------------------------------ session / diagnostics
  /** 'off' | 'starting' | 'running' | 'permission_denied' | 'camera_error'. */
  setSession(kind) {
    if (this.session === kind) return;
    this.session = kind;
    if (kind === 'off') {
      this.activeAlert = null;
      this.episodes.clear();
    }
    this.version += 1;
  }

  /** fps / thermal / parity / intrinsics for `engineDetail()` (never part of the UI contract). */
  noteStatus(s = {}) {
    if (Number.isFinite(s.fps) && s.fps > 0) {
      this.detail.fpsSamples += 1;
      this.detail.fpsMean += (s.fps - this.detail.fpsMean) / this.detail.fpsSamples;
    }
    if (s.thermalPause) this.detail.thermalPauses += 1;
    if (s.error) this.detail.errors += 1;
    if (s.intrinsicsSource) this.detail.intrinsicsSource = String(s.intrinsicsSource);
    if (Number.isFinite(s.focalScale)) this.detail.focalScale = s.focalScale;
    if (s.parity !== undefined) this.detail.parity = s.parity;
    if (s.orientationFault !== undefined) this.detail.orientationFault = Boolean(s.orientationFault);
    if (s.seededFromPrior !== undefined) this.detail.seededFromPrior = Boolean(s.seededFromPrior);
    if (s.permission) this.detail.permission = String(s.permission);
  }

  /** The driver asked for a fresh calibration: show LOST until the engine reports otherwise. */
  recalibrate() {
    if (this.monitor) {
      try { this.monitor.resetCalibration(); } catch (err) { /* ignore */ }
    }
    this.confidence = 'NONE';
    this.calibrationState = CALIBRATION_STATE.LOST;
    this.lostUntilT = (this.tLast === null ? 0 : this.tLast) + LOST_AFTER_MOVE_S;
    this.metrics = { ...this.metrics, calibrationQuality: null };
    this.recalibrations += 1;
    this.version += 1;
  }

  // ------------------------------------------------------------------ the per-frame update
  /**
   * @param {object} output  a `MonitorOutput` from `DriverMonitor`
   * @param {Array}  events  defaults to `output.events`
   * @param {object} voiced  defaults to `output.voiced`
   */
  update(output, events, voiced) {
    if (!output) return this.snapshot();
    const t = Number.isFinite(output.t) ? output.t : (this.tLast === null ? 0 : this.tLast);
    if (this.t0 === null) this.t0 = t;
    let dt = this.tLast === null ? 0 : Math.max(0, t - this.tLast);
    if (dt > MAX_DT_S) dt = MAX_DT_S;
    this.tLast = t;
    this.frames += 1;
    this.monitoredSeconds += dt;

    const list = events || output.events || [];
    const spoken = voiced !== undefined ? voiced : output.voiced;

    this._updateTime(output, dt, t);
    this._updateCalibration(output, list, t);
    this._updateDrowsiness(output, t);
    this._updateExposure(output, dt);
    this._ingestEvents(output, list, spoken, t);
    this._expireEpisodes(output, t);
    this._pickActive();
    return this.snapshot();
  }

  _updateTime(out, dt, t) {
    const face = Boolean(out.face_present);
    if (face) {
      this.facePresentSeconds += dt;
      this.lastFaceT = t;
      if (out.eyes_readable !== false) this.eyesReadableSeconds += dt;
    } else if (this.lastFaceT === null) {
      this.lastFaceT = t;                       // start the no-face clock at the first frame
    }
    if (out.confidence === 'CONFIRMED') this.calibratedSeconds += dt;

    // the two "has it cleared" clocks the episode rules read
    if (String(out.glance_class || 'none') === 'forward') {
      if (this._forwardSinceT === null) this._forwardSinceT = t;
    } else {
      this._forwardSinceT = null;
    }
    const openness = Number.isFinite(out.openness) ? out.openness : 1.0;
    if (openness >= 0.5) {
      if (this._eyesOpenSinceT === null) this._eyesOpenSinceT = t;
    } else {
      this._eyesOpenSinceT = null;
    }
  }

  _updateCalibration(out, events, t) {
    const confidence = String(out.confidence || 'NONE');
    if (confidence !== this.confidence) {
      this.confidence = confidence;
      this.version += 1;
    }
    this.admittedS = Number.isFinite(out.admitted_s) ? out.admitted_s : 0;

    for (const e of events) {
      if (!e || !e.type) continue;
      if (e.type === EventType.CALIBRATION_PROVISIONAL && this.timeToProvisionalS === null) {
        this.timeToProvisionalS = this.t0 === null ? null : t - this.t0;
      } else if (e.type === EventType.CALIBRATION_CONFIRMED && this.timeToConfirmedS === null) {
        this.timeToConfirmedS = this.t0 === null ? null : t - this.t0;
      } else if (e.type === EventType.RECALIBRATED) {
        this.recalibrations += 1;
        this.lostUntilT = t + LOST_AFTER_MOVE_S;
      } else if (e.type === EventType.CAMERA_MOVED) {
        this.cameraMoved += 1;
        this.lostUntilT = t + LOST_AFTER_MOVE_S;
      } else if (e.type === EventType.DRIVER_CHANGE) {
        this.driverChange += 1;
        this.lostUntilT = t + LOST_AFTER_MOVE_S;
      } else if (e.type === EventType.REFERENCE_STALE) {
        this.staleEvents += 1;
      }
    }

    let state;
    if (this.session === 'off') state = CALIBRATION_STATE.OFF;
    else if (this.lostUntilT !== null && t < this.lostUntilT) state = CALIBRATION_STATE.LOST;
    else if (confidence === 'STALE') state = CALIBRATION_STATE.LOST;
    else if (confidence === 'PROVISIONAL') state = CALIBRATION_STATE.PROVISIONAL;
    else if (confidence === 'CONFIRMED') state = CALIBRATION_STATE.CONFIRMED;
    else state = CALIBRATION_STATE.CALIBRATING;
    if (this.lostUntilT !== null && t >= this.lostUntilT) this.lostUntilT = null;
    if (state !== this.calibrationState) {
      this.calibrationState = state;
      this.version += 1;
    }
    this.calibrationProgress = clamp01(this.admittedS / CONFIRM_TARGET_S);

    // quality: null until the reference is usable, then the mode's concentration, discounted
    // while it is still provisional
    let quality = null;
    if (confidence === 'PROVISIONAL' || confidence === 'CONFIRMED') {
      const conc = Number.isFinite(out.concentration) ? out.concentration : 0;
      quality = clamp01(conc / 0.8) * (confidence === 'CONFIRMED' ? 1 : 0.7);
      quality = Math.round(quality * 100) / 100;
    }
    if (quality !== this.metrics.calibrationQuality) {
      this.metrics = { ...this.metrics, calibrationQuality: quality };
      this.version += 1;
    }
  }

  _updateDrowsiness(out, t) {
    const level = String(out.drowsiness_level || 'ALERT');
    const perclos = Number.isFinite(out.perclos) ? out.perclos : null;
    const perclosLong = Number.isFinite(out.perclos_long) ? out.perclos_long : null;
    if (perclos !== null && perclos > this.maxPerclos60) this.maxPerclos60 = perclos;
    if (perclosLong !== null && perclosLong > this.maxPerclos180) this.maxPerclos180 = perclosLong;

    const advisory = this._advisoryLevel();
    const score = Number.isFinite(out.drowsiness_score) ? out.drowsiness_score : 0;
    let value;
    if (level === 'SEVERE') value = 3;
    else if (level === 'DROWSY') value = 2;
    else value = (perclos !== null && perclos >= advisory) || score >= DROWSY_HINT_SCORE ? 1 : 0;

    if (value !== this.drowsiness.level || perclos !== this.drowsiness.perclos) {
      this.drowsiness = { level: value, perclos };
      this.version += 1;
    }
    if (value > this.metrics.drowsinessPeak) {
      this.metrics = { ...this.metrics, drowsinessPeak: value };
      this.version += 1;
    }

    // one history sample every 10 s of drive time
    const rel = this.t0 === null ? 0 : t - this.t0;
    if (this._lastHistoryT === null || rel - this._lastHistoryT >= DROWSINESS_SAMPLE_S) {
      this._lastHistoryT = rel;
      const history = this.metrics.drowsinessHistory.concat([{ t: Math.round(rel), level: value }]);
      this.metrics = {
        ...this.metrics,
        drowsinessHistory: history.length > DROWSINESS_HISTORY_MAX
          ? history.slice(history.length - DROWSINESS_HISTORY_MAX) : history,
      };
      this.version += 1;
    }
  }

  _advisoryLevel() {
    const d = this.config && this.config.drowsiness;
    return d && Number.isFinite(d.perclos_advisory) ? d.perclos_advisory : PERCLOS_ADVISORY_DEFAULT;
  }

  /** Eyes off the road: the part of each glance beyond its class allowance, plus look-down. */
  _updateExposure(out, dt) {
    const cls = String(out.glance_class || 'none');
    const glanceS = Number.isFinite(out.glance_s) ? out.glance_s : 0;
    const lookDown = out.look_down === true || out.zone === 'LOOK_DOWN';
    let seconds = 0;
    if (Object.prototype.hasOwnProperty.call(EYES_OFF_ALLOWANCE, cls)) {
      if (glanceS > EYES_OFF_ALLOWANCE[cls]) seconds = dt;
      if (glanceS > this.maxGlanceS) this.maxGlanceS = glanceS;
    }
    if (seconds === 0 && lookDown) seconds = dt;
    if (seconds > 0) {
      this.metrics = { ...this.metrics, eyesOffRoadSeconds: this.metrics.eyesOffRoadSeconds + seconds };
      this.version += 1;
    }

    // per-class glance counts (diagnostics only): one per episode, reclassified on escalation
    if (Object.prototype.hasOwnProperty.call(EYES_OFF_ALLOWANCE, cls)) {
      if (!this._inGlance) {
        this._inGlance = true;
        this._glanceClass = cls;
        this._glanceCounts[cls] += 1;
      } else if (cls !== this._glanceClass) {
        if (this._glanceCounts[this._glanceClass] > 0) this._glanceCounts[this._glanceClass] -= 1;
        this._glanceCounts[cls] += 1;
        this._glanceClass = cls;
      }
    } else {
      this._inGlance = false;
      this._glanceClass = null;
    }
  }

  // ------------------------------------------------------------------ episodes
  _ingestEvents(out, events, voiced, t) {
    for (const event of events) {
      if (!event || !event.type) continue;
      this._noteEngineEpisode(event);
      const alertType = EVENT_TO_ALERT[event.type];
      if (!alertType) continue;
      const isVoiced = voiced !== null && voiced !== undefined && event === voiced;
      const severity = severityOf(event, alertType);
      if (severity !== ALERT_SEVERITY.INFO && !isVoiced) {
        // the arbiter did not sound it (cooldown, speed gate, acknowledgement): not an alert
        continue;
      }
      this._raise(alertType, severity, event, t);
    }

    // the display-only PERCLOS advisory (DETECTION_DESIGN §7a) arrives as the engine's own
    // PERCLOS_ADVISORY event (dms/drowsiness.js, at most once per 300 s) and is mapped above
  }

  _noteEngineEpisode(event) {
    const tStart = Number.isFinite(event.t_start) ? event.t_start : event.t;
    const prev = this._engineStarts.get(event.type);
    if (prev === undefined || prev !== tStart) {
      this._engineStarts.set(event.type, tStart);
      this.engineEpisodes[event.type] = (this.engineEpisodes[event.type] || 0) + 1;
    }
  }

  _raise(alertType, severity, event, t) {
    const tStart = Number.isFinite(event.t_start) ? event.t_start : t;
    const id = `${alertType}@${num(tStart, 3)}`;
    if (this.acknowledged.has(id)) return;

    const existing = this.episodes.get(id);
    if (existing) {
      existing.lastEventT = t;
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
        // the episode escalated (INFO -> WARNING -> CRITICAL).  It keeps its id, so alertAudio
        // re-arms on the severity change, and its single count MOVES to the new severity.
        existing.severity = severity;
        this._count(id, alertType, severity, t);
        this.version += 1;
      }
      return;
    }

    // INFO never pre-empts or interrupts a live WARNING / CRITICAL
    if (severity === ALERT_SEVERITY.INFO && this._hasLiveAudible()) return;

    const copy = alertCopy(alertType);
    this.episodes.set(id, {
      id,
      type: alertType,
      severity,
      title: copy.title,
      message: copy.message,
      startedAt: this._now(),
      startedT: t,
      tStart,
      lastEventT: t,
      engineType: event.type,
      priority: PRIORITY[event.type] || 0,
    });
    // An episode that already ended and is re-raised by a late repeat of the SAME t_start shows
    // again but is never counted twice: the count belongs to the id, once, at its highest
    // severity so far.
    this._count(id, alertType, severity, t);
    this.version += 1;
  }

  /** Count an episode id once, at its highest severity so far. */
  _count(id, alertType, severity, t) {
    const previous = this._counted.get(id);
    if (previous !== undefined && SEVERITY_RANK[severity] <= SEVERITY_RANK[previous]) {
      // already counted at this severity or higher: only the points hold is refreshed
      if (severity !== ALERT_SEVERITY.INFO && DISTRACTION_ALERTS.has(alertType)) this._lastDistractionT = t;
      return;
    }
    const counts = { ...this.metrics.alertCounts };
    if (previous !== undefined) counts[previous] = Math.max(0, (counts[previous] || 0) - 1);
    counts[severity] = (counts[severity] || 0) + 1;
    const byType = { ...this.metrics.alertsByType };
    if (previous === undefined) byType[alertType] = (byType[alertType] || 0) + 1;
    this.metrics = { ...this.metrics, alertCounts: counts, alertsByType: byType };
    this._counted.set(id, severity);

    if (severity !== ALERT_SEVERITY.INFO) {
      if (DISTRACTION_ALERTS.has(alertType)) {
        if (!this._distractionIds.has(id)) {
          this._distractionIds.add(id);
          this._distractionEpisodes += 1;
        }
        this._lastDistractionT = t;
      }
      if (STREAK_BREAKERS.has(alertType)) this._streakBreaker = true;
    }
  }

  _hasLiveAudible() {
    for (const e of this.episodes.values()) {
      if (e.severity !== ALERT_SEVERITY.INFO) return true;
    }
    return false;
  }

  _expireEpisodes(out, t) {
    for (const [id, e] of Array.from(this.episodes)) {
      if (this._ended(e, out, t)) {
        this.episodes.delete(id);
        this.version += 1;
      }
    }
  }

  _ended(e, out, t) {
    const sinceEvent = t - e.lastEventT;
    const live = t - e.startedT;
    if (e.severity === ALERT_SEVERITY.INFO && live < INFO_MIN_S
        && e.type !== ALERT_TYPE.NO_MIRROR_CHECK) {
      return false;                                   // keep an INFO banner readable
    }
    if (GLANCE_ALERTS.has(e.type)) {
      const cleared = this._forwardSinceT !== null && t - this._forwardSinceT >= FORWARD_CLEAR_S;
      return cleared || sinceEvent >= NO_REPEAT_CLEAR_S;
    }
    if (CLOSURE_ALERTS.has(e.type)) {
      const cleared = this._eyesOpenSinceT !== null && t - this._eyesOpenSinceT >= EYES_OPEN_CLEAR_S;
      return cleared || sinceEvent >= NO_REPEAT_CLEAR_S;
    }
    if (LINGERING_ALERTS.has(e.type)) return sinceEvent >= LINGER_CLEAR_S;
    if (e.type === ALERT_TYPE.NO_FACE) return Boolean(out.face_present);
    if (e.type === ALERT_TYPE.EYES_NOT_VISIBLE) return out.eyes_readable !== false;
    if (e.type === ALERT_TYPE.NO_MIRROR_CHECK) return live >= NO_MIRROR_CLEAR_S;
    return live >= INFO_MIN_S;
  }

  _pickActive() {
    let best = null;
    for (const e of this.episodes.values()) {
      if (best === null) { best = e; continue; }
      const a = SEVERITY_RANK[e.severity] - SEVERITY_RANK[best.severity];
      if (a > 0 || (a === 0 && (e.priority > best.priority
          || (e.priority === best.priority && e.startedT > best.startedT)))) {
        best = e;
      }
    }
    const current = this.activeAlert;
    if (best === null) {
      if (current !== null) {
        this.activeAlert = null;
        this.version += 1;
      }
      return;
    }
    if (!current || current.id !== best.id || current.severity !== best.severity) {
      this.activeAlert = {
        id: best.id,
        type: best.type,
        severity: best.severity,
        title: best.title,
        message: best.message,
        startedAt: best.startedAt,
      };
      this.version += 1;
    }
  }

  /** The driver dismissed an alert: end the episode and tell the engine (30 s suppression). */
  acknowledge(id) {
    if (!id) return;
    this.acknowledged.add(id);
    if (this.episodes.has(id)) {
      this.episodes.delete(id);
      this.version += 1;
    }
    if (this.monitor && this.tLast !== null) {
      try { this.monitor.acknowledge(this.tLast); } catch (err) { /* ignore */ }
    }
    this._pickActive();
  }

  // ------------------------------------------------------------------ the contract values
  status() {
    if (this.session === 'permission_denied') return MONITOR_STATUS.PERMISSION_DENIED;
    if (this.session === 'camera_error') return MONITOR_STATUS.CAMERA_ERROR;
    if (this.session === 'off') return MONITOR_STATUS.OFF;
    if (this.session === 'starting') return MONITOR_STATUS.STARTING;
    if (this.tLast === null) return MONITOR_STATUS.STARTING;
    if (this.lastFaceT !== null && this.tLast - this.lastFaceT > NO_FACE_STATUS_S) return MONITOR_STATUS.NO_FACE;
    if (this.confidence === 'NONE') return MONITOR_STATUS.CALIBRATING;
    return MONITOR_STATUS.ACTIVE;
  }

  calibration() {
    return {
      state: this.session === 'off' ? CALIBRATION_STATE.OFF : this.calibrationState,
      progress: num(this.calibrationProgress, 3),
      quality: this.metrics.calibrationQuality,
    };
  }

  snapshot() {
    return {
      version: this.version,
      status: this.status(),
      calibration: this.calibration(),
      activeAlert: this.activeAlert,
      drowsiness: this.drowsiness,
      metrics: this.metrics,
    };
  }

  // ------------------------------------------------------------------ §10 / §11 extras
  /** The richer diagnostics of DETECTION_DESIGN §10, as plain values (Firestore safe). */
  engineDetail() {
    const faceShare = this.monitoredSeconds > 0 ? this.facePresentSeconds / this.monitoredSeconds : 0;
    return {
      monitoredSeconds: num(this.monitoredSeconds, 1),
      facePresentSeconds: num(this.facePresentSeconds, 1),
      faceShare: num(faceShare, 3),
      eyesReadableSeconds: num(this.eyesReadableSeconds, 1),
      calibratedSeconds: num(this.calibratedSeconds, 1),
      frames: this.frames,
      fpsMean: num(this.detail.fpsMean, 2),
      thermalPauses: this.detail.thermalPauses,
      errors: this.detail.errors,
      intrinsicsSource: this.detail.intrinsicsSource,
      focalScale: this.detail.focalScale === null ? null : num(this.detail.focalScale, 4),
      permission: this.detail.permission,
      orientationFault: Boolean(this.detail.orientationFault),
      parityOk: this.detail.parity === null || this.detail.parity === undefined
        ? null : Boolean(this.detail.parity.ok),
      calibration: {
        finalConfidence: this.confidence,
        timeToProvisionalS: this.timeToProvisionalS === null ? null : num(this.timeToProvisionalS, 1),
        timeToConfirmedS: this.timeToConfirmedS === null ? null : num(this.timeToConfirmedS, 1),
        recalibrations: this.recalibrations,
        staleEvents: this.staleEvents,
        cameraMoved: this.cameraMoved,
        driverChange: this.driverChange,
        seededFromPrior: Boolean(this.detail.seededFromPrior),
        admittedSeconds: num(this.admittedS, 1),
      },
      glances: {
        driving_task: this._glanceCounts.driving_task,
        lateral: this._glanceCounts.lateral,
        cabin: this._glanceCounts.cabin,
        maxGlanceS: num(this.maxGlanceS, 2),
      },
      drowsiness: {
        maxPerclos60: num(this.maxPerclos60, 4),
        maxPerclos180: num(this.maxPerclos180, 4),
        peakLevel: this.metrics.drowsinessPeak,
      },
      engineEpisodes: { ...this.engineEpisodes },
      distractionEpisodes: this._distractionEpisodes,
    };
  }

  /** DETECTION_DESIGN §11: no point while a voiced attention alert is within 10 s or level 3. */
  pointsBlocked(nowS) {
    if (this.drowsiness.level >= 3) return true;
    const t = Number.isFinite(nowS) ? nowS : this.tLast;
    if (this._lastDistractionT === null || t === null) return false;
    return t - this._lastDistractionT <= POINTS_HOLD_S;
  }

  /** DETECTION_DESIGN §11: >= 3 distraction episodes, or one PROLONGED_STARE / EYES_CLOSED. */
  streakBreaking() {
    return this._distractionEpisodes >= STREAK_EPISODES || this._streakBreaker;
  }
}

module.exports = {
  MonitoringBridge,
  EVENT_TO_ALERT,
  GLANCE_ALERTS,
  CLOSURE_ALERTS,
  LINGERING_ALERTS,
  DISTRACTION_ALERTS,
  STREAK_BREAKERS,
  severityOf,
  PERCLOS_ADVISORY_EVENT,
  EYES_OFF_ALLOWANCE,
  INFO_MIN_S,
  FORWARD_CLEAR_S,
  NO_REPEAT_CLEAR_S,
  LINGER_CLEAR_S,
  NO_FACE_STATUS_S,
  DROWSINESS_HISTORY_MAX,
  POINTS_HOLD_S,
};
