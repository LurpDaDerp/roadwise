'use strict';
/**
 * Attention rules on the gaze relative to the forward reference (`dms/attention.py`,
 * docs/DESIGN.md §5).
 *
 * Inputs per frame: the driver-relative gaze `[left_deg, up_deg]` when the gaze is usable, the
 * head deviation (turn, pitch) from the resting head pose, the calibration confidence and the
 * vehicle speed when known.  Every calibrated frame gets a zone and a GLANCE CLASS
 * (forward / driving_task / lateral / cabin); a glance's limits follow the most severe class it
 * visited.  Every rule is a time-based state machine; nothing here assumes a frame rate.
 */

const { Event, EventType } = require('./alerts');
const { zone } = require('./config');
const { Deque, EventCounter, TimeWindowSum, pyRound } = require('./util');

const OTHER = zone('OTHER', 'other');
// head-pitch override zones (the gaze reads relative pitch at gain ~0.1): not in config.zones
const LOOK_DOWN = zone('LOOK_DOWN', 'far');
const LOOK_UP = zone('LOOK_UP', 'far');
const ON_ROAD_KINDS = ['road', 'road_wide'];       // the windshield: forward at every confidence level
const DELAY_KINDS = ['mirror', 'instrument'];      // AttenD delay; never "beyond" the hard limits
const LATERAL_ZONES = ['OTHER', 'PASSENGER'];      // outside-world gaze through the side glass
const PHONE_ZONES = ['LAP', 'LOOK_DOWN'];
const PITCH_FILTER_MAX = 64;                       // ring size of the look-down pitch median

// glance classes, in increasing severity (a glance takes the most severe class it visited)
const FORWARD = 0, DRIVING_TASK = 1, LATERAL = 2, CABIN = 3;
const CLASS_NAMES = ['forward', 'driving_task', 'lateral', 'cabin'];

/** Camera-relative deviation angles -> driver terms `[left_deg, up_deg]`. */
function driverRelative(dyaw, dpitch, cfg) {
  let left = cfg.image_right_is_driver_left ? dyaw : -dyaw;
  if (cfg.driver_side === 'right') left = -left;
  return [left * cfg.rel_yaw_gain, dpitch * cfg.rel_pitch_gain];
}

function inRange(v, lo, hi) {
  return (lo === null || v >= lo) && (hi === null || v <= hi);
}

/** Move a far zone's bound nearest the reference away from it by `margin` degrees. */
function widenFar(z, margin) {
  if (margin <= 0.0 || z.kind !== 'far') return z;
  const push = (rng) => {
    const lo = rng[0], hi = rng[1];
    if (lo !== null && hi !== null) {
      if (Math.abs(lo) <= Math.abs(hi)) {
        return lo * hi >= 0 ? [lo >= 0 ? lo + margin : lo - margin, hi] : [lo, hi];
      }
      return [lo, hi <= 0 ? hi - margin : hi + margin];
    }
    if (lo !== null) return [lo >= 0 ? lo + margin : lo - margin, hi];
    if (hi !== null) return [lo, hi <= 0 ? hi - margin : hi + margin];
    return rng;
  };
  return zone(z.name, z.kind, push(z.left), push(z.up), z.ellipse, z.center_up);
}

/** First matching zone in order; `OTHER` when none matches. */
function classify(leftDeg, upDeg, zones, provisionalMargin = 0.0) {
  for (const raw of zones) {
    const z = widenFar(raw, provisionalMargin);
    if (z.ellipse) {
      const a = z.left[0] || 1e-6;
      const b = z.up[0] || 1e-6;
      if ((leftDeg / a) ** 2 + ((upDeg - z.center_up) / b) ** 2 <= 1.0) return z;
    } else if (inRange(leftDeg, z.left[0], z.left[1]) && inRange(upDeg, z.up[0], z.up[1])) {
      return z;
    }
  }
  return OTHER;
}

/**
 * Causal median of the samples of the last `window_s` seconds (bounded ring of `cap`
 * samples).  Fewer than 3 samples -> the raw value.
 */
class TimeMedian {
  constructor(windowS, cap = PITCH_FILTER_MAX) {
    this.window = windowS;
    this.items = new Deque(Math.max(1, Math.trunc(cap)));
  }

  reset() {
    this.items.clear();
  }

  push(t, v) {
    this.items.push([t, v]);
    while (this.items.length && this.items.first()[0] < t - this.window) this.items.shift();
    const n = this.items.length;
    if (n < 3) return v;
    const s = this.items.toArray().map((x) => x[1]).sort((a, b) => a - b);
    return n % 2 ? s[(n - (n % 2)) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }
}

function emptyState(bufferS) {
  return {
    zone: 'UNKNOWN',
    zone_kind: 'unknown',
    left_deg: NaN,
    up_deg: NaN,
    buffer_s: bufferS,
    offroad_30s: 0.0,
    glance_s: 0.0,
    far_glance_s: 0.0,
    prc: null,
    gaze_sd_deg: null,
    head_turned_s: 0.0,
    head_down_s: 0.0,
    enabled: false,
    glance_class: 'none',
    exposure_60s: 0.0,
    offroad_glances_60s: 0,
    road_share_60s: null,
    look_down: false,
    events: [],
  };
}

class AttentionRules {
  constructor(config) {
    this.cfg = config.attention;
    this.zones = config.zones.slice();
    this.max_dt = config.front_end.max_dt_s;
    this._usable = false;
    this.reset();
  }

  reset() {
    const c = this.cfg;
    this.t_last = null;
    // head-pitch override (median-filtered pitch, hysteresis)
    this.pitch_median = new TimeMedian(c.look_filter_s);
    this.look_down = false;
    this.look_up = false;
    // A1
    this.far_since = null;
    this.far_zone = '';
    this.far_confirmed = false;
    this.phone_glances = new EventCounter(c.phone_pattern_window_s);
    this.phone_since = null;
    this.phone_counted_this_glance = false;
    this.phone_last_emit = null;
    // A2
    this.glance_since = null;
    this.glance_rank = FORWARD;
    this.glance_counted = false;
    this.glance_head_sum = 0.0;
    this.glance_head_n = 0;
    this.road_since = null;
    this.glance_last_emit = null;
    this.glance_stare_emitted = false;
    this.unusable_since = null;
    // A3
    this.offroad = new TimeWindowSum(c.vats_window_s);
    this.mirror_dwell_since = null;
    this.vats_last_emit = null;
    // A4
    this.buffer = c.attend_buffer_s;
    this.onroad_since = null;
    this.offroad_since = null;
    this.buffer_last_emit = null;
    this.delay_zone_since = null;
    // A5
    this.prc_inside = new TimeWindowSum(c.prc_window_s);
    this.prc_usable = new TimeWindowSum(c.prc_window_s);
    this.sum_l = new TimeWindowSum(c.prc_window_s);
    this.sum_u = new TimeWindowSum(c.prc_window_s);
    this.sum_l2 = new TimeWindowSum(c.prc_window_s);
    this.sum_u2 = new TimeWindowSum(c.prc_window_s);
    this.prc_last_emit = null;
    this.last_mirror_t = null;
    this.mirror_check_last_emit = null;
    this.enabled_since = null;
    // A6
    this.head_turn_since = null;
    this.head_down_since = null;
    this.head_turn_last_emit = null;
    this.head_down_last_emit = null;
    // display outputs
    this.exposure = new TimeWindowSum(c.exposure_window_s);
    this.share_forward = new TimeWindowSum(c.exposure_window_s);
    this.share_total = new TimeWindowSum(c.exposure_window_s);
    this.glance_starts = new EventCounter(c.exposure_window_s);
  }

  // ------------------------------------------------------------------ update
  update(t, relAngles, usable, headDevDeg, headPitchDev, confidence, speedKmh = null) {
    const c = this.cfg;
    const events = [];
    const dt = this.t_last === null ? 0.0 : Math.min(Math.max(0.0, t - this.t_last), this.max_dt);
    const gapHold = this.t_last === null ? 0.0 : Math.max(0.0, t - this.t_last - this.max_dt);
    this.t_last = t;
    const st = emptyState(this.buffer);
    const SHIFT_ATTRS = ['far_since', 'glance_since', 'road_since', 'mirror_dwell_since', 'delay_zone_since', 'phone_since'];
    if (gapHold >= AttentionRules.UNUSABLE_RESET_S) {
      this._resetGlances();
    } else if (gapHold > 0.0 && this.unusable_since === null) {
      for (const attr of SHIFT_ATTRS) {
        if (this[attr] !== null && this[attr] !== undefined) this[attr] = this[attr] + gapHold;
      }
    }
    const calibrated = confidence === 'PROVISIONAL' || confidence === 'CONFIRMED' || confidence === 'STALE';
    const full = confidence === 'CONFIRMED';
    const margin = full ? 0.0 : c.provisional_margin_deg;
    const moving = speedKmh !== null && speedKmh !== undefined && Number.isFinite(speedKmh) && speedKmh >= c.lateral_speed_kmh;
    st.enabled = calibrated;
    if (calibrated && this.enabled_since === null) this.enabled_since = t;
    if (!calibrated) this.enabled_since = null;

    // ---- A6 head rules (independent of the gaze; the raw pitch) -----------------------
    this._usable = Boolean(usable);
    this._headRules(t, dt, headDevDeg, headPitchDev, events, st);

    // ---- head-pitch override: LOOK_DOWN / LOOK_UP on the median-filtered pitch ----------
    let pitchF = null;
    if (headPitchDev !== null && headPitchDev !== undefined && Number.isFinite(headPitchDev)) {
      pitchF = this.pitch_median.push(t, headPitchDev);
    }
    this._pitchOverride(calibrated && pitchF !== null, pitchF);
    st.look_down = this.look_down;
    const override = this.look_down ? LOOK_DOWN : (this.look_up ? LOOK_UP : null);

    const gazeOk = calibrated && Boolean(usable) && relAngles !== null && relAngles !== undefined
      && Number.isFinite(relAngles[0]) && Number.isFinite(relAngles[1]);
    if (!gazeOk && override === null) {
      if (this.unusable_since === null) {
        this.unusable_since = t;
      } else if (t - this.unusable_since >= AttentionRules.UNUSABLE_RESET_S) {
        this._resetGlances();
      }
      if (!calibrated) this._resetGlances();
      this._display(t, st);
      st.events = events;
      return st;
    }
    if (this.unusable_since !== null) {
      const shift = t - this.unusable_since;
      for (const attr of SHIFT_ATTRS) {
        if (this[attr] !== null && this[attr] !== undefined) this[attr] = this[attr] + shift;
      }
    }
    this.unusable_since = null;

    // ---- zone and glance class ------------------------------------------------------------
    let left = NaN, up = NaN;
    let z = OTHER;
    let beyondAxis = false;
    if (gazeOk) {
      [left, up] = driverRelative(relAngles[0], relAngles[1], c);
      z = classify(left, up, this.zones, margin);
      // the lateral bound may be asymmetric in DRIVER terms (phone option; null = hard_left_deg
      // on both sides = the reference).  `left` is already in driver terms, so the same test
      // holds for RHD.
      const driverLimit = c.hard_left_driver_deg === null || c.hard_left_driver_deg === undefined
        ? c.hard_left_deg : c.hard_left_driver_deg;
      const passengerLimit = c.hard_left_passenger_deg === null || c.hard_left_passenger_deg === undefined
        ? c.hard_left_deg : c.hard_left_passenger_deg;
      beyondAxis = !DELAY_KINDS.includes(z.kind)
        && (left > driverLimit + margin || left < -(passengerLimit + margin)
            || up < c.hard_down_deg - margin || up > c.hard_up_deg + margin);
    }
    let rank;
    if (override !== null) {
      if (z.kind !== 'far') z = override;
      rank = CABIN;
    } else if (ON_ROAD_KINDS.includes(z.kind)) {
      rank = FORWARD;
    } else if (z.kind === 'instrument') {
      rank = DRIVING_TASK;
    } else if (z.kind === 'mirror') {
      rank = LATERAL;
    } else if (beyondAxis) {
      rank = CABIN;
    } else if (LATERAL_ZONES.includes(z.name)) {
      rank = LATERAL;
    } else {
      rank = CABIN;
    }
    st.zone = z.name;
    st.zone_kind = z.kind;
    st.left_deg = left;
    st.up_deg = up;
    const forward = rank === FORWARD;
    const far = rank === CABIN && (z.kind === 'far' || beyondAxis);

    // ---- A1 far-off glances (info: statistics) ----------------------------------------
    if (far) {
      if (this.far_since === null) {
        this.far_since = t;
        this.far_zone = z.name;
        this.far_confirmed = false;
      }
      const dwell = t - this.far_since;
      st.far_glance_s = dwell;
      if (dwell >= c.far_glance_confirm_s && !this.far_confirmed) {
        this.far_confirmed = true;
        events.push(new Event(EventType.OFF_ROAD_GLANCE, t, this.far_since, dwell, z.name, { audible: false }));
      }
    } else {
      this.far_since = null;
    }

    // ---- A2 long glance / stare per glance class ----------------------------------------
    if (forward) {
      if (this.road_since === null) this.road_since = t;
      if (this.glance_since !== null && t - this.road_since >= c.glance_gap_tolerance_s) this._endGlance();
    } else {
      this.road_since = null;
      if (this.glance_since === null) {
        this._endGlance();
        this.glance_since = t;
      }
      this.glance_rank = Math.max(this.glance_rank, rank);
      if (headDevDeg !== null && headDevDeg !== undefined && Number.isFinite(headDevDeg)) {
        this.glance_head_sum += headDevDeg;
        this.glance_head_n += 1;
      }
    }
    if (this.glance_since !== null && !forward) {
      const dur = t - this.glance_since;
      st.glance_s = dur;
      if (!this.glance_counted && dur >= c.glance_count_min_s) {
        this.glance_counted = true;
        this.glance_starts.push(this.glance_since);
      }
      if (PHONE_ZONES.includes(z.name)) {
        if (this.phone_since === null) this.phone_since = t;
        if (!this.phone_counted_this_glance && t - this.phone_since >= c.phone_glance_min_s) {
          this.phone_counted_this_glance = true;
          this.phone_glances.push(t);
          this._phonePattern(t, events);
        }
      } else {
        this.phone_since = null;
      }
      const limit = this._glanceLimit(this.glance_rank, moving);
      const cls = CLASS_NAMES[this.glance_rank];
      const coupled = this.glance_rank !== LATERAL || this.glance_head_n === 0
        || this.glance_head_sum >= c.lateral_head_min_deg * this.glance_head_n;
      if (!coupled) {
        // no alert: a lateral glance with the head at rest is a reference offset
      } else if (dur >= limit + c.stare_after_s) {
        if (!this.glance_stare_emitted || (this.glance_last_emit !== null && t - this.glance_last_emit >= c.escalation_s)) {
          this.glance_stare_emitted = true;
          this.glance_last_emit = t;
          events.push(new Event(EventType.PROLONGED_STARE, t, this.glance_since, dur, z.name, { class: cls }));
        }
      } else if (dur >= limit) {
        if (this.glance_last_emit === null || t - this.glance_last_emit >= c.escalation_s) {
          this.glance_last_emit = t;
          events.push(new Event(EventType.LONG_GLANCE, t, this.glance_since, dur, z.name, { class: cls }));
        }
      }
    }
    st.glance_class = forward ? 'forward' : CLASS_NAMES[this.glance_rank];
    if (!full) {
      this.onroad_since = null;
      this.offroad_since = null;
      this.mirror_dwell_since = null;
      this.delay_zone_since = null;
    }

    // ---- A3 accumulated eyes-off-road (VATS) ------------------------------------------
    if (full) {
      let mirrorOk = false;
      if (z.kind === 'mirror') {
        if (this.mirror_dwell_since === null) this.mirror_dwell_since = t;
        mirrorOk = t - this.mirror_dwell_since >= c.vats_mirror_ignore_s;
      } else {
        this.mirror_dwell_since = null;
      }
      let counted;
      if (forward || (rank === LATERAL && !moving)) {
        counted = 0.0;
      } else if (z.kind === 'mirror') {
        counted = mirrorOk ? 1.0 : 0.0;
      } else {
        counted = 1.0;
      }
      this.offroad.push(t, counted, dt);
      const total = this.offroad.total(t);
      st.offroad_30s = total;
      if (total >= c.vats_offroad_s && (this.vats_last_emit === null || t - this.vats_last_emit >= 5.0)) {
        this.vats_last_emit = t;
        events.push(new Event(EventType.VATS_DISTRACTION, t, t - c.vats_window_s, total, z.name));
      }
      if (total < c.vats_offroad_s) this.vats_last_emit = null;
    }

    // ---- A4 AttenD attention buffer ------------------------------------------------------
    if (full) {
      if (forward) {
        this.offroad_since = null;
        if (this.onroad_since === null) this.onroad_since = t;
        if (t - this.onroad_since >= c.attend_refill_latency_s) {
          this.buffer = Math.min(c.attend_buffer_s, this.buffer + dt);
        }
      } else {
        this.onroad_since = null;
        if (this.offroad_since === null) this.offroad_since = t;
        if (DELAY_KINDS.includes(z.kind)) {
          if (this.delay_zone_since === null) this.delay_zone_since = t;
          if (t - this.delay_zone_since >= c.attend_mirror_delay_s) {
            this.buffer = Math.max(0.0, this.buffer - dt);
          }
        } else {
          this.delay_zone_since = null;
          this.buffer = Math.max(0.0, this.buffer - dt);
        }
      }
      if (forward) this.delay_zone_since = null;
      st.buffer_s = this.buffer;
      if (this.buffer <= 1e-4) {
        if (this.buffer_last_emit === null || t - this.buffer_last_emit >= c.escalation_s) {
          this.buffer_last_emit = t;
          events.push(new Event(EventType.ATTENTION_BUFFER_EMPTY, t, this.offroad_since !== null ? this.offroad_since : t,
                                0.0, z.name, { audible: false }));
        }
      } else {
        this.buffer_last_emit = null;
      }
    }

    // ---- A5 gaze concentration (gaze frames only) / mirror checks ----------------------
    if (full && gazeOk) {
      const inside = Math.hypot(left, up) <= c.prc_cone_deg ? 1.0 : 0.0;
      this.prc_inside.push(t, inside, dt);
      this.prc_usable.push(t, 1.0, dt);
      this.sum_l.push(t, left, dt);
      this.sum_u.push(t, up, dt);
      this.sum_l2.push(t, left * left, dt);
      this.sum_u2.push(t, up * up, dt);
      const usableS = this.prc_usable.total(t);
      if (usableS >= 0.5 * c.prc_window_s) {
        const prc = this.prc_inside.total(t) / usableS;
        const ml = this.sum_l.total(t, false) / usableS;
        const mu = this.sum_u.total(t, false) / usableS;
        const varSum = Math.max(0.0, this.sum_l2.total(t) / usableS - ml * ml)
          + Math.max(0.0, this.sum_u2.total(t) / usableS - mu * mu);
        const sd = Math.sqrt(varSum);
        st.prc = prc;
        st.gaze_sd_deg = sd;
        if (prc >= c.prc_concentration && sd < c.prc_max_sd_deg) {
          if (this.prc_last_emit === null || t - this.prc_last_emit >= 30.0) {
            this.prc_last_emit = t;
            events.push(new Event(EventType.GAZE_CONCENTRATION, t, t - c.prc_window_s, prc, '',
                                  { gaze_sd_deg: pyRound(sd, 2) }));
          }
        }
      }
    }
    if (full) {
      if (z.kind === 'mirror') this.last_mirror_t = t;
      const since = this.last_mirror_t !== null ? this.last_mirror_t : this.enabled_since;
      if (since !== null && t - since >= c.mirror_check_s) {
        if (this.mirror_check_last_emit === null || t - this.mirror_check_last_emit >= c.mirror_check_s) {
          this.mirror_check_last_emit = t;
          events.push(new Event(EventType.NO_MIRROR_CHECK, t, since, t - since));
        }
      }
    }

    // ---- display: exposure (severity-weighted off-road time) and road share ---------------
    let w;
    if (rank === DRIVING_TASK) w = c.exposure_w_driving_task;
    else if (rank === LATERAL) w = c.exposure_w_lateral;
    else if (rank === CABIN) w = c.exposure_w_cabin;
    else w = 0.0;
    if (w > 0.0 && this.glance_since !== null && t - this.glance_since > c.exposure_long_after_s) {
      w *= c.exposure_long_factor;
    }
    this.exposure.push(t, w, dt);
    this.share_forward.push(t, forward ? 1.0 : 0.0, dt);
    this.share_total.push(t, 1.0, dt);
    this._display(t, st);

    st.events = events;
    return st;
  }

  // ------------------------------------------------------------------ pieces
  _glanceLimit(rank, moving) {
    const c = this.cfg;
    if (rank === DRIVING_TASK) return c.long_glance_mirror_s;
    if (rank === LATERAL) return moving ? c.lateral_glance_moving_s : c.lateral_glance_s;
    return c.long_glance_s;
  }

  _pitchOverride(ok, pitchDev) {
    const c = this.cfg;
    if (!ok) {
      this.look_down = false;
      this.look_up = false;
      return;
    }
    this.look_down = this.look_down ? pitchDev <= -c.look_down_exit_deg : pitchDev <= -c.look_down_deg;
    this.look_up = this.look_up ? pitchDev >= c.look_up_exit_deg : pitchDev >= c.look_up_deg;
  }

  _display(t, st) {
    const c = this.cfg;
    st.exposure_60s = this.exposure.total(t);
    st.offroad_glances_60s = this.glance_starts.count(t);
    const total = this.share_total.total(t);
    if (total >= 0.5 * c.exposure_window_s) {
      st.road_share_60s = Math.min(1.0, this.share_forward.total(t) / total);
    }
  }

  _phonePattern(t, events) {
    const c = this.cfg;
    const n = this.phone_glances.count(t);
    if (n >= c.phone_pattern_count && (this.phone_last_emit === null || t - this.phone_last_emit >= c.escalation_s)) {
      this.phone_last_emit = t;
      events.push(new Event(EventType.PHONE_PATTERN, t, this.phone_glances.times.first(), n));
    }
  }

  _endGlance() {
    this.glance_since = null;
    this.glance_last_emit = null;
    this.glance_stare_emitted = false;
    this.glance_rank = FORWARD;
    this.glance_counted = false;
    this.glance_head_sum = 0.0;
    this.glance_head_n = 0;
    this.phone_since = null;
    this.phone_counted_this_glance = false;
  }

  _resetGlances(keepFar = false) {
    this._endGlance();
    this.road_since = null;
    if (!keepFar) this.far_since = null;
    this.onroad_since = null;
    this.offroad_since = null;
    this.mirror_dwell_since = null;
    this.delay_zone_since = null;
  }

  _headRules(t, dt, headDev, pitchDev, events, st) {
    const c = this.cfg;
    if (headDev === null || headDev === undefined || !Number.isFinite(headDev)) {
      this.head_turn_since = null;
      this.head_down_since = null;
      return;
    }
    if (headDev >= c.head_turn_deg) {
      if (this.head_turn_since === null) this.head_turn_since = t;
      const dur = t - this.head_turn_since;
      st.head_turned_s = dur;
      const need = this._usable ? c.head_rule_s : Math.max(c.head_rule_s, c.head_rule_audible_s);
      if (dur >= need && (this.head_turn_last_emit === null || t - this.head_turn_last_emit >= c.escalation_s)) {
        this.head_turn_last_emit = t;
        events.push(new Event(EventType.HEAD_TURNED, t, this.head_turn_since, dur, '', { audible: !this._usable }));
      }
    } else {
      this.head_turn_since = null;
      this.head_turn_last_emit = null;
    }
    if (pitchDev !== null && pitchDev !== undefined && Number.isFinite(pitchDev) && pitchDev <= -c.head_down_deg) {
      if (this.head_down_since === null) this.head_down_since = t;
      const dur = t - this.head_down_since;
      st.head_down_s = dur;
      const need = this._usable ? c.head_rule_s : Math.max(c.head_rule_s, c.head_rule_audible_s);
      if (dur >= need && (this.head_down_last_emit === null || t - this.head_down_last_emit >= c.escalation_s)) {
        this.head_down_last_emit = t;
        events.push(new Event(EventType.HEAD_DOWN, t, this.head_down_since, dur, '', { audible: !this._usable }));
      }
    } else {
      this.head_down_since = null;
      this.head_down_last_emit = null;
    }
  }
}

AttentionRules.UNUSABLE_RESET_S = 2.0;   // a glance whose gaze was unusable this long starts over

module.exports = {
  OTHER,
  LOOK_DOWN,
  LOOK_UP,
  ON_ROAD_KINDS,
  DELAY_KINDS,
  LATERAL_ZONES,
  PHONE_ZONES,
  PITCH_FILTER_MAX,
  FORWARD,
  DRIVING_TASK,
  LATERAL,
  CABIN,
  CLASS_NAMES,
  driverRelative,
  classify,
  widenFar,
  TimeMedian,
  AttentionRules,
};
