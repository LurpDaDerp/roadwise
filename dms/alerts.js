'use strict';
/** Event and alert vocabulary shared by every rule module and the alert arbiter (`dms/alerts.py`). */

const { pyRound } = require('./util');

/** INFO = logged / displayed, WARNING = audible once, CRITICAL = audible and repeating. */
const Severity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

/** String enum: the value equals the Python `EventType.X.value`. */
const EventType = {
  // attention (docs/DESIGN.md §5)
  OFF_ROAD_GLANCE: 'OFF_ROAD_GLANCE',
  PHONE_PATTERN: 'PHONE_PATTERN',
  LONG_GLANCE: 'LONG_GLANCE',
  PROLONGED_STARE: 'PROLONGED_STARE',
  VATS_DISTRACTION: 'VATS_DISTRACTION',
  ATTENTION_BUFFER_EMPTY: 'ATTENTION_BUFFER_EMPTY',
  GAZE_CONCENTRATION: 'GAZE_CONCENTRATION',
  NO_MIRROR_CHECK: 'NO_MIRROR_CHECK',
  HEAD_TURNED: 'HEAD_TURNED',
  HEAD_DOWN: 'HEAD_DOWN',
  // drowsiness (§6)
  BLINK: 'BLINK',
  PROLONGED_CLOSURE: 'PROLONGED_CLOSURE',
  MICROSLEEP: 'MICROSLEEP',
  SLEEP: 'SLEEP',
  EYES_CLOSED: 'EYES_CLOSED',
  SLOW_BLINKS: 'SLOW_BLINKS',
  DROWSY: 'DROWSY',
  SEVERE_DROWSY: 'SEVERE_DROWSY',
  YAWN: 'YAWN',
  FREQUENT_YAWNING: 'FREQUENT_YAWNING',
  HEAD_NOD: 'HEAD_NOD',
  // system (§7)
  DRIVER_NOT_VISIBLE: 'DRIVER_NOT_VISIBLE',
  CALIBRATION_PROVISIONAL: 'CALIBRATION_PROVISIONAL',
  CALIBRATION_CONFIRMED: 'CALIBRATION_CONFIRMED',
  RECALIBRATED: 'RECALIBRATED',
  REFERENCE_STALE: 'REFERENCE_STALE',
  DRIVER_CHANGE: 'DRIVER_CHANGE',
  CAMERA_MOVED: 'CAMERA_MOVED',
  EYES_UNREADABLE: 'EYES_UNREADABLE',
  DROWSINESS_RECOVERED: 'DROWSINESS_RECOVERED',
  // appended for the phone (DETECTION_DESIGN §7a): a display-only "consider a break" hint.
  // Keep it LAST so the C twin's enum order stays comparable.
  PERCLOS_ADVISORY: 'PERCLOS_ADVISORY',
};

/** higher = more urgent; the arbiter voices the highest active audible alert */
const PRIORITY = {
  [EventType.EYES_CLOSED]: 100,
  [EventType.SLEEP]: 98,
  [EventType.MICROSLEEP]: 95,
  [EventType.SEVERE_DROWSY]: 90,
  [EventType.PROLONGED_STARE]: 85,
  [EventType.LONG_GLANCE]: 80,
  [EventType.PHONE_PATTERN]: 75,
  [EventType.VATS_DISTRACTION]: 70,
  [EventType.ATTENTION_BUFFER_EMPTY]: 68,
  [EventType.OFF_ROAD_GLANCE]: 65,
  [EventType.HEAD_DOWN]: 60,
  [EventType.HEAD_TURNED]: 55,
  [EventType.DROWSY]: 50,
  [EventType.FREQUENT_YAWNING]: 45,
  [EventType.PROLONGED_CLOSURE]: 40,
  [EventType.SLOW_BLINKS]: 35,
  [EventType.DRIVER_NOT_VISIBLE]: 30,
  [EventType.HEAD_NOD]: 20,
  [EventType.YAWN]: 15,
  [EventType.GAZE_CONCENTRATION]: 10,
  [EventType.NO_MIRROR_CHECK]: 8,
  [EventType.RECALIBRATED]: 5,
  [EventType.CAMERA_MOVED]: 5,
  [EventType.DRIVER_CHANGE]: 5,
  [EventType.REFERENCE_STALE]: 4,
  [EventType.CALIBRATION_CONFIRMED]: 3,
  [EventType.CALIBRATION_PROVISIONAL]: 2,
  [EventType.EYES_UNREADABLE]: 6,
  [EventType.DROWSINESS_RECOVERED]: 3,
  [EventType.PERCLOS_ADVISORY]: 7,
  [EventType.BLINK]: 0,
};

const SEVERITY = {
  [EventType.EYES_CLOSED]: Severity.CRITICAL,
  [EventType.SLEEP]: Severity.CRITICAL,
  [EventType.MICROSLEEP]: Severity.CRITICAL,
  [EventType.SEVERE_DROWSY]: Severity.CRITICAL,
  [EventType.PROLONGED_STARE]: Severity.CRITICAL,
  [EventType.LONG_GLANCE]: Severity.WARNING,
  [EventType.PHONE_PATTERN]: Severity.WARNING,
  [EventType.VATS_DISTRACTION]: Severity.WARNING,
  [EventType.ATTENTION_BUFFER_EMPTY]: Severity.WARNING,
  [EventType.OFF_ROAD_GLANCE]: Severity.INFO,
  [EventType.HEAD_DOWN]: Severity.WARNING,
  [EventType.HEAD_TURNED]: Severity.WARNING,
  [EventType.DROWSY]: Severity.WARNING,
  [EventType.FREQUENT_YAWNING]: Severity.WARNING,
  [EventType.PROLONGED_CLOSURE]: Severity.WARNING,
  [EventType.SLOW_BLINKS]: Severity.INFO,
  [EventType.DRIVER_NOT_VISIBLE]: Severity.WARNING,
  [EventType.HEAD_NOD]: Severity.INFO,
  [EventType.YAWN]: Severity.INFO,
  [EventType.GAZE_CONCENTRATION]: Severity.INFO,
  [EventType.NO_MIRROR_CHECK]: Severity.INFO,
  [EventType.RECALIBRATED]: Severity.INFO,
  [EventType.CAMERA_MOVED]: Severity.INFO,
  [EventType.DRIVER_CHANGE]: Severity.INFO,
  [EventType.REFERENCE_STALE]: Severity.INFO,
  [EventType.CALIBRATION_CONFIRMED]: Severity.INFO,
  [EventType.CALIBRATION_PROVISIONAL]: Severity.INFO,
  [EventType.EYES_UNREADABLE]: Severity.INFO,
  [EventType.DROWSINESS_RECOVERED]: Severity.INFO,
  [EventType.PERCLOS_ADVISORY]: Severity.INFO,
  [EventType.BLINK]: Severity.INFO,
};

const MESSAGE = {
  [EventType.OFF_ROAD_GLANCE]: 'Eyes far off the road',
  [EventType.PHONE_PATTERN]: 'Repeated glances down - phone use?',
  [EventType.LONG_GLANCE]: 'Eyes off the road too long',
  [EventType.PROLONGED_STARE]: 'Look back at the road!',
  [EventType.VATS_DISTRACTION]: 'Too much time looking away',
  [EventType.ATTENTION_BUFFER_EMPTY]: 'Attention buffer empty',
  [EventType.GAZE_CONCENTRATION]: 'Fixed stare - stay engaged',
  [EventType.NO_MIRROR_CHECK]: 'No mirror check for a while',
  [EventType.HEAD_TURNED]: 'Head turned away from the road',
  [EventType.HEAD_DOWN]: 'Head down',
  [EventType.BLINK]: 'blink',
  [EventType.PROLONGED_CLOSURE]: 'Eyes closing',
  [EventType.MICROSLEEP]: 'Microsleep - eyes open!',
  [EventType.SLEEP]: 'Asleep - WAKE UP!',
  [EventType.EYES_CLOSED]: 'EYES CLOSED - WAKE UP!',
  [EventType.SLOW_BLINKS]: 'Slow blinks',
  [EventType.DROWSY]: 'Drowsiness detected - take a break',
  [EventType.SEVERE_DROWSY]: 'Severe drowsiness - stop driving',
  [EventType.YAWN]: 'Yawn',
  [EventType.FREQUENT_YAWNING]: 'Frequent yawning - take a break',
  [EventType.HEAD_NOD]: 'Head nod',
  [EventType.DRIVER_NOT_VISIBLE]: 'Driver not visible',
  [EventType.CALIBRATION_PROVISIONAL]: 'Forward reference provisional',
  [EventType.CALIBRATION_CONFIRMED]: 'Forward reference confirmed',
  [EventType.RECALIBRATED]: 'Forward reference re-calibrated',
  [EventType.REFERENCE_STALE]: 'Forward reference stale',
  [EventType.DRIVER_CHANGE]: 'Driver change suspected',
  [EventType.CAMERA_MOVED]: 'Camera or seat moved',
  [EventType.EYES_UNREADABLE]: 'Eyes not visible - head-only monitoring',
  [EventType.DROWSINESS_RECOVERED]: 'Alertness recovered',
  [EventType.PERCLOS_ADVISORY]: 'Consider a break soon',
};

/** sound pattern names the apps map to tones / buzzer patterns */
const SOUND = {
  [EventType.EYES_CLOSED]: 'siren',
  [EventType.SLEEP]: 'siren',
  [EventType.MICROSLEEP]: 'siren',
  [EventType.SEVERE_DROWSY]: 'double_low',
  [EventType.DROWSY]: 'double_low',
  [EventType.FREQUENT_YAWNING]: 'double_low',
  [EventType.PROLONGED_STARE]: 'double_high',
  [EventType.LONG_GLANCE]: 'double_high',
  [EventType.PHONE_PATTERN]: 'double_high',
  [EventType.VATS_DISTRACTION]: 'double_high',
  [EventType.ATTENTION_BUFFER_EMPTY]: 'double_high',
  [EventType.OFF_ROAD_GLANCE]: 'double_high',
  [EventType.HEAD_DOWN]: 'double_high',
  [EventType.HEAD_TURNED]: 'double_high',
  [EventType.DRIVER_NOT_VISIBLE]: 'single_low',
};

/**
 * One rule outcome.  `t_start` is when the condition began, `t` when the event was emitted,
 * `value` a rule-specific number, `detail` a short label, `extra` rule-specific keys.
 */
class Event {
  constructor(type, t, tStart, value = 0.0, detail = '', extra = null) {
    this.type = type;
    this.t = t;
    this.t_start = tStart;
    this.value = value;
    this.detail = detail;
    this.extra = extra || {};
  }

  get severity() {
    return Object.prototype.hasOwnProperty.call(SEVERITY, this.type) ? SEVERITY[this.type] : Severity.INFO;
  }

  get priority() {
    return Object.prototype.hasOwnProperty.call(PRIORITY, this.type) ? PRIORITY[this.type] : 0;
  }

  get message() {
    return Object.prototype.hasOwnProperty.call(MESSAGE, this.type) ? MESSAGE[this.type] : this.type;
  }

  get sound() {
    return Object.prototype.hasOwnProperty.call(SOUND, this.type) ? SOUND[this.type] : null;
  }

  /** The reference `to_dict()`: `t` / `t_start` rounded to 3 decimals, `value` to 4. */
  toDict() {
    const out = {
      type: this.type,
      t: pyRound(this.t, 3),
      t_start: pyRound(this.t_start, 3),
      value: pyRound(this.value, 4),
      detail: this.detail,
      severity: this.severity,
    };
    for (const k of Object.keys(this.extra)) out[k] = this.extra[k];
    return out;
  }
}

module.exports = { Severity, EventType, PRIORITY, SEVERITY, MESSAGE, SOUND, Event };
