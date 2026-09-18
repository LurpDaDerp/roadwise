'use strict';
/**
 * Rule-based drowsiness detection from landmark features (`dms/drowsiness.py`, DESIGN §6).
 *
 * Eye closure is read from the eye aspect ratio (EAR) normalised by the driver's own open-eye
 * baseline; PERCLOS, blink statistics, prolonged closures / microsleeps, yawns (mouth aspect
 * ratio) and head nods feed a 0-100 drowsiness score.  Everything is time-based: the tracker is
 * driven by frame timestamps, never by frame counts.
 */

const { Event, EventType } = require('./alerts');
const { BucketWindowSum, DecayingHistogram1D, Deque, EventCounter, TimeWindowSum, meanArray } = require('./util');

const LEVELS = ['ALERT', 'DROWSY', 'SEVERE'];
/** PERCLOS_ADVISORY (phone option) is emitted at most this often (DETECTION_DESIGN §7a). */
const ADVISORY_REPEAT_S = 300.0;

function clip(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function emptyDrowsinessState() {
  return {
    openness: NaN,
    eyes_open: true,
    ear_open_baseline: null,
    ear_closed_baseline: null,
    closure_active: false,
    closure_duration_s: 0.0,
    blink_rate_per_min: 0.0,
    blink_mean_duration_s: 0.0,
    long_blink_count: 0,
    perclos: null,
    perclos_valid: false,
    perclos_long: null,
    perclos_long_valid: false,
    yawn_active: false,
    yawn_count_window: 0,
    nod_count_window: 0,
    score: 0.0,
    level: 'ALERT',
    perclos_advisory: false,
    events: [],
  };
}

class DrowsinessTracker {
  constructor(config) {
    this.cfg = config;
    this.d = config.drowsiness;
    this.max_dt = config.front_end.max_dt_s;
    this.look_down_deg = config.attention.look_down_deg;
    this.reset();
  }

  // --- lifecycle -----------------------------------------------------------------------
  reset() {
    const d = this.d;
    this.t_prev = null;
    this.t_first = null;
    this.dt_typical = null;
    this.ear_hist = new DecayingHistogram1D(d.ear_hist_lo, d.ear_hist_hi, d.ear_hist_bin, d.ear_window_s);
    this.closed_hist = new DecayingHistogram1D(d.ear_hist_lo, d.ear_hist_hi, d.ear_hist_bin, d.ear_closed_window_s);
    this.ear_seen_s = 0.0;
    this.ear_open_frozen = null;       // phone option: the frozen open-eye baseline (null = not yet)
    // closure state machine
    this.closure_active = false;
    this.closure_start = 0.0;
    this.closure_ignored = false;
    this.closure_prolonged_sent = false;
    this.closure_alert_sent = false;
    this.closure_microsleep_sent = false;
    this.closure_sleep_sent = false;
    this.closure_frames = 0;
    this.closure_deep_frames = 0;
    this.closure_reads = [];
    this.closure_closed_s = 0.0;       // PERCLOS seconds this closure contributed (phone option)
    this.closure_next_repeat = 0.0;
    this.closure_eyes_closed_sent = false;
    this.microsleeps = new EventCounter(d.score_window_s);
    // blink statistics: [t_end, duration]
    this.blinks = new Deque();
    this.slow_blink_last = -1e9;
    // PERCLOS
    this.closed_time = new TimeWindowSum(d.perclos_window_s);
    this.usable_time = new TimeWindowSum(d.perclos_window_s);
    this.perclos_long_sum = new BucketWindowSum(d.perclos_long_window_s, d.perclos_long_bucket_s);
    // yawns
    this.yawn_active = false;
    this.yawn_start = 0.0;
    this.yawn_sent = false;
    this.yawns = new EventCounter(d.yawn_window_s);
    this.yawns_score = new EventCounter(d.score_window_s);
    this.frequent_yawn_last = -1e9;
    // head nods
    this.pitch_hist = new DecayingHistogram1D(-90.0, 90.0, 1.0, d.nod_baseline_window_s);
    this.pitch_recent = new Deque();
    this.nod_drop_t = null;
    this.nod_closed_s = 0.0;
    this.nods = new EventCounter(d.nod_window_s);
    // level / alerts
    this.level = 'ALERT';
    this.level_last_event = -1e9;
    this.level_calm_since = null;
    this.episode_start = 0.0;
    this.advisory_last = -1e9;         // phone option: last PERCLOS_ADVISORY (>= ADVISORY_REPEAT_S apart)
    this.state = emptyDrowsinessState();
  }

  // --- helpers -------------------------------------------------------------------------
  _baselines() {
    const d = this.d;
    let q = this.ear_hist.quantile(d.ear_open_percentile / 100.0);
    if (q === null) q = d.ear_open_prior;
    if (this.ear_seen_s < d.ear_seed_s) q = Math.max(q, d.ear_open_prior);
    let earOpen = Math.max(q, d.ear_open_floor);
    // phone option: sleepy drivers stop opening their eyes fully, so the running baseline is
    // floored at `ear_open_freeze_ratio` x its value after `ear_open_freeze_s` of tracking
    if (d.ear_open_freeze_s > 0.0) {
      if (this.ear_open_frozen === null && this.ear_seen_s >= d.ear_open_freeze_s) {
        this.ear_open_frozen = earOpen;
      }
      if (this.ear_open_frozen !== null) {
        earOpen = Math.max(earOpen, d.ear_open_freeze_ratio * this.ear_open_frozen);
      }
    }
    let earClosed = d.ear_closed_ratio * earOpen;
    if (this.closed_hist.mass() >= d.ear_closed_min_mass) {
      const observed = this.closed_hist.quantile(0.02);
      if (observed !== null) earClosed = clip(observed, 0.0, d.ear_closed_max_ratio * earOpen);
    }
    return [earOpen, earClosed];
  }

  _blinkStats(t) {
    const d = this.d;
    while (this.blinks.length && this.blinks.first()[0] < t - d.blink_window_s) this.blinks.shift();
    const n = this.blinks.length;
    const elapsed = this.t_first === null ? d.blink_window_s : Math.min(d.blink_window_s, Math.max(t - this.t_first, 1e-6));
    const rate = elapsed >= d.blink_rate_min_elapsed_s ? (60.0 * n) / elapsed : 0.0;
    const mean = n ? meanArray(this.blinks.toArray().map((b) => b[1])) : 0.0;
    let longCount = 0;
    for (let i = 0; i < n; i++) if (this.blinks.get(i)[1] > d.long_blink_s) longCount += 1;
    return [rate, mean, longCount];
  }

  _endClosure(t, events, counted) {
    const d = this.d;
    const duration = t - this.closure_start;
    // phone option: a closure that ends within perclos_blink_exclude_s is a blink, and PERCLOS is
    // defined on slow closures - its closed seconds leave both accumulators at the end time
    if (counted && !this.closure_ignored && d.perclos_blink_exclude_s > 0.0
        && duration <= d.perclos_blink_exclude_s && this.closure_closed_s > 0.0) {
      this.closed_time.push(t, -this.closure_closed_s, 1.0);
      this.perclos_long_sum.push(t, -this.closure_closed_s, 0.0);
    }
    this.closure_closed_s = 0.0;
    if (counted && !this.closure_ignored) {
      if (d.blink_min_s <= duration && duration <= d.blink_max_s) {
        this.blinks.push([t, duration]);
        events.push(new Event(EventType.BLINK, t, this.closure_start, duration));
        for (const v of this.closure_reads) this.closed_hist.add(v, t);
      } else if (duration > d.blink_max_s) {
        this.blinks.push([t, duration]);
      }
    }
    this.closure_active = false;
    this.closure_ignored = false;
    this.closure_prolonged_sent = false;
    this.closure_alert_sent = false;
    this.closure_microsleep_sent = false;
    this.closure_sleep_sent = false;
    this.closure_eyes_closed_sent = false;
  }

  // --- main update ---------------------------------------------------------------------
  update(t, feat, headTurnDeg, headPitchDev = null) {
    const d = this.d;
    const events = [];
    const rawDt = this.t_prev === null ? 0.0 : Math.max(0.0, t - this.t_prev);
    const dt = clip(rawDt, 0.0, this.max_dt);
    const gapLimit = Math.max(d.stream_gap_s, d.stream_gap_factor * (this.dt_typical === null ? 0.0 : this.dt_typical));
    const gap = this.t_prev !== null && rawDt > gapLimit;
    if (this.t_prev !== null && !gap && rawDt > 0.0) {
      this.dt_typical = this.dt_typical === null ? rawDt : 0.9 * this.dt_typical + 0.1 * rawDt;
    }
    this.t_prev = t;
    if (this.t_first === null) this.t_first = t;
    if (gap) {
      if (this.closure_active) {
        this.closure_ignored = true;
        this._endClosure(t, events, false);
      }
      this.yawn_active = false;
      this.nod_drop_t = null;
      this.pitch_recent.clear();
    }
    const headTurned = headTurnDeg !== null && headTurnDeg !== undefined && headTurnDeg > d.closure_head_turn_deg;
    const headDown = headPitchDev !== null && headPitchDev !== undefined && Number.isFinite(headPitchDev)
      && headPitchDev <= -this.look_down_deg;
    const earNear = feat.ear_near === undefined ? NaN : feat.ear_near;
    const earRead = Number.isFinite(earNear) ? earNear : (feat.ear === undefined ? NaN : feat.ear);
    const earOk = Boolean(feat.face_present) && Number.isFinite(earRead);
    if (this.closure_active && headDown && t - this.closure_start < d.prolonged_closure_s) {
      this.closure_ignored = true;
      this._endClosure(t, events, false);
    }
    const usable = earOk && !headTurned && (this.closure_active || !headDown);

    // ---- eye closure -------------------------------------------------------------
    let openness = NaN;
    let earOpen = null;
    let earClosed = null;
    if (earOk) {
      if (!this.closure_active && !headDown) this.ear_hist.add(earRead, t);
      this.ear_seen_s += dt;
      [earOpen, earClosed] = this._baselines();
      openness = clip((earRead - earClosed) / Math.max(earOpen - earClosed, 1e-6), 0.0, 1.0);
    }
    if (usable) {
      const closed = openness < d.perclos_closed ? 1.0 : 0.0;
      const closedContribution = closed * dt;
      this.usable_time.push(t, 1.0, dt);
      this.closed_time.push(t, closed, dt);
      this.perclos_long_sum.push(t, closed * dt, dt);
      if (this.closure_active) {
        if (openness > d.close_exit) this._endClosure(t, events, true);
      } else if (openness < d.close_enter) {
        this.closure_active = true;
        this.closure_start = t;
        this.closure_frames = 0;
        this.closure_deep_frames = 0;
        this.closure_reads = [];
        this.closure_closed_s = 0.0;
        this.closure_ignored = false;
        this.closure_next_repeat = d.microsleep_s + d.microsleep_repeat_s;
      }
      if (this.closure_active) {
        this.closure_closed_s += closedContribution;   // this frame belongs to the running closure
        this.closure_reads.push(earRead);
        this.closure_frames += 1;
        if (openness < d.perclos_closed) this.closure_deep_frames += 1;
        const deep = this.closure_deep_frames >= d.closure_deep_fraction * this.closure_frames;
        let duration = t - this.closure_start;
        const lowRate = this.dt_typical !== null && this.dt_typical > d.blink_max_s;
        if (lowRate && this.closure_frames < d.closure_min_frames_low_rate) duration = 0.0;
        if (duration >= d.prolonged_closure_s && !this.closure_prolonged_sent) {
          this.closure_prolonged_sent = true;
          events.push(new Event(EventType.PROLONGED_CLOSURE, t, this.closure_start, duration, '', { audible: false }));
        }
        if (duration >= d.prolonged_closure_alert_s && !this.closure_alert_sent) {
          this.closure_alert_sent = true;
          events.push(new Event(EventType.PROLONGED_CLOSURE, t, this.closure_start, duration, 'alert', { audible: false }));
        }
        if (duration >= d.microsleep_s && deep && !this.closure_microsleep_sent) {
          this.closure_microsleep_sent = true;
          this.microsleeps.push(t);
          this.closure_next_repeat = Math.max(this.closure_next_repeat, duration + d.microsleep_repeat_s);
          events.push(new Event(EventType.MICROSLEEP, t, this.closure_start, duration));
        } else if (this.closure_microsleep_sent && deep && duration >= this.closure_next_repeat) {
          this.closure_next_repeat += d.microsleep_repeat_s;
          events.push(new Event(EventType.MICROSLEEP, t, this.closure_start, duration, 'repeat'));
        }
        if (duration >= d.sleep_s && deep && !this.closure_sleep_sent) {
          this.closure_sleep_sent = true;
          events.push(new Event(EventType.SLEEP, t, this.closure_start, duration));
        }
        if (duration >= d.eyes_closed_s && deep && !this.closure_eyes_closed_sent) {
          this.closure_eyes_closed_sent = true;
          events.push(new Event(EventType.EYES_CLOSED, t, this.closure_start, duration));
        }
      }
    } else if (this.closure_active) {
      this.closure_ignored = true;
      this._endClosure(t, events, false);
    }

    let [rate, meanDur, longCount] = this._blinkStats(t);
    const slowStream = this.dt_typical !== null
      && (this.dt_typical > d.blink_max_s
          || (d.blink_stats_min_fps > 0.0 && this.dt_typical > 1.0 / d.blink_stats_min_fps));
    if (slowStream) {
      rate = 0.0;
      meanDur = 0.0;
      longCount = 0;
    }
    if (this.blinks.length >= d.slow_blink_min_count && meanDur > d.slow_blink_mean_s
        && t - this.slow_blink_last >= d.slow_blink_repeat_s) {
      this.slow_blink_last = t;
      events.push(new Event(EventType.SLOW_BLINKS, t, t - d.blink_window_s, meanDur));
    }

    // ---- PERCLOS -----------------------------------------------------------------
    const usableS = this.usable_time.total(t);
    let perclos = null;
    const perclosValid = usableS >= d.perclos_min_usable_s;
    if (usableS > 0.0) perclos = this.closed_time.total(t) / usableS;
    const [closedLongS, usableLongS] = this.perclos_long_sum.totals(t);
    const perclosLongValid = usableLongS >= d.perclos_long_min_usable_s;
    const perclosLong = perclosLongValid ? closedLongS / usableLongS : null;

    // ---- yawns -------------------------------------------------------------------
    const mar = feat.mar === undefined ? NaN : feat.mar;
    const marOk = Boolean(feat.face_present) && Number.isFinite(mar);
    if (marOk && mar > d.yawn_mar) {
      if (!this.yawn_active) {
        this.yawn_active = true;
        this.yawn_start = t;
        this.yawn_sent = false;
      }
    } else if (this.yawn_active && (!marOk || mar < d.yawn_mar_exit || (!this.yawn_sent && mar <= d.yawn_mar))) {
      this.yawn_active = false;
    }
    if (this.yawn_active) {
      const duration = t - this.yawn_start;
      if (duration > d.yawn_max_s) {
        this.yawn_active = false;
      } else if (duration >= d.yawn_min_s && !this.yawn_sent) {
        this.yawn_sent = true;
        this.yawns.push(t);
        this.yawns_score.push(t);
        events.push(new Event(EventType.YAWN, t, this.yawn_start, duration));
        if (this.yawns.count(t) >= d.yawn_count && t - this.frequent_yawn_last >= d.frequent_yawn_repeat_s) {
          this.frequent_yawn_last = t;
          events.push(new Event(EventType.FREQUENT_YAWNING, t, this.yawn_start, this.yawns.count(t), '',
                                { audible: this.state.level !== 'ALERT' }));
        }
      }
    }

    // ---- head nods ---------------------------------------------------------------
    const headPitch = feat.head_pitch === undefined ? NaN : feat.head_pitch;
    if (feat.face_present && Number.isFinite(headPitch)) {
      this.pitch_hist.add(headPitch, t);
      const baseline = this.pitch_hist.median();
      this.pitch_recent.push([t, headPitch]);
      const keep = Math.max(d.nod_drop_s, d.nod_recover_s);
      while (this.pitch_recent.length && this.pitch_recent.first()[0] < t - keep) this.pitch_recent.shift();
      if (baseline !== null) {
        const near = baseline - d.nod_near_deg;
        const dropped = headPitch <= baseline - d.nod_drop_deg;
        const eyesShut = this.closure_active || (Number.isFinite(openness) && openness < d.close_enter);
        if (this.nod_drop_t === null) {
          let any = false;
          for (let i = 0; i < this.pitch_recent.length; i++) {
            const item = this.pitch_recent.get(i);
            if (item[0] >= t - d.nod_drop_s && item[1] >= near) {
              any = true;
              break;
            }
          }
          if (dropped && any) {
            this.nod_drop_t = t;
            this.nod_closed_s = eyesShut ? dt : 0.0;
          }
        } else {
          if (eyesShut) this.nod_closed_s += dt;
          if (headPitch >= near) {
            if (t - this.nod_drop_t <= d.nod_recover_s && this.nod_closed_s >= d.nod_min_closed_s) {
              this.nods.push(t);
              events.push(new Event(EventType.HEAD_NOD, t, this.nod_drop_t, t - this.nod_drop_t));
            }
            this.nod_drop_t = null;
          } else if (t - this.nod_drop_t > d.nod_recover_s) {
            this.nod_drop_t = null;
          }
        }
      }
    } else {
      this.nod_drop_t = null;
    }

    // ---- score and level ---------------------------------------------------------
    const nBlinks = this.blinks.length;
    const longShare = nBlinks >= d.slow_blink_min_count ? longCount / nBlinks : 0.0;
    const p60 = perclosValid ? perclos : null;
    let score = 0.0;
    if (p60 !== null && perclosLong !== null) score += d.score_perclos_gain * Math.min(p60, perclosLong);
    score += d.score_long_blink_share * longShare;
    score += d.score_yawn * this.yawns_score.count(t);
    score += d.score_nod * this.nods.count(t);
    score += d.score_microsleep * Math.max(0, this.microsleeps.count(t) - 1);
    score = clip(score, 0.0, 100.0);
    const rawDrowsy = ((p60 !== null && p60 >= d.perclos_drowsy && perclosLong !== null && perclosLong >= d.perclos_long_drowsy)
                       || score >= d.score_drowsy);
    const rawSevere = (p60 !== null && p60 >= d.perclos_severe) || score >= d.score_severe;
    let level = this.level;
    let risen = false;
    if (rawSevere && level !== 'SEVERE') {
      level = 'SEVERE';
      risen = true;
    } else if (rawDrowsy && level === 'ALERT') {
      level = 'DROWSY';
      risen = true;
    }
    const extra = {
      perclos: p60 === null ? null : roundTo(p60, 3),
      perclos_long: perclosLong === null ? null : roundTo(perclosLong, 3),
    };
    if (risen) {
      if (this.level === 'ALERT') this.episode_start = t;
      this.level_calm_since = null;
      this.level_last_event = t;
      const etype = level === 'SEVERE' ? EventType.SEVERE_DROWSY : EventType.DROWSY;
      events.push(new Event(etype, t, t - d.perclos_window_s, score, '', extra));
    } else if (level !== 'ALERT') {
      const holds = level === 'SEVERE' ? rawSevere : rawDrowsy;
      if (holds) {
        this.level_calm_since = null;
        if (t - this.level_last_event >= d.drowsy_repeat_s) {
          this.level_last_event = t;
          const etype = level === 'SEVERE' ? EventType.SEVERE_DROWSY : EventType.DROWSY;
          events.push(new Event(etype, t, t - d.perclos_window_s, score, 'repeat', extra));
        }
      } else {
        if (this.level_calm_since === null) this.level_calm_since = t;
        if (t - this.level_calm_since >= d.level_recovery_s) {
          if (level === 'SEVERE') {
            if ((p60 === null || p60 < d.perclos_severe_exit) && score < d.score_severe_exit) {
              level = 'DROWSY';
              this.level_calm_since = rawDrowsy ? null : t;
            }
          } else if ((perclosLong === null || perclosLong < d.perclos_recover) && score < d.score_drowsy_exit) {
            level = 'ALERT';
            this.level_calm_since = null;
            events.push(new Event(EventType.DROWSINESS_RECOVERED, t, this.episode_start, t - this.episode_start, '', extra));
          }
        }
      }
    }
    this.level = level;

    // phone option: display-only "consider a break" hint from the 60-s PERCLOS while still ALERT
    const advisory = d.perclos_advisory !== null && d.perclos_advisory !== undefined
      && level === 'ALERT' && p60 !== null && p60 >= d.perclos_advisory;
    if (advisory && t - this.advisory_last >= ADVISORY_REPEAT_S) {
      this.advisory_last = t;
      events.push(new Event(EventType.PERCLOS_ADVISORY, t, t - d.perclos_window_s, p60, '',
                            { perclos: roundTo(p60, 3) }));
    }

    this.state = {
      openness,
      eyes_open: !Number.isFinite(openness) || openness >= d.eyes_open_threshold,
      ear_open_baseline: earOpen,
      ear_closed_baseline: earClosed,
      closure_active: this.closure_active,
      closure_duration_s: this.closure_active ? t - this.closure_start : 0.0,
      blink_rate_per_min: rate,
      blink_mean_duration_s: meanDur,
      long_blink_count: longCount,
      perclos: perclosValid ? perclos : null,
      perclos_valid: perclosValid,
      perclos_long: perclosLong,
      perclos_long_valid: perclosLongValid,
      yawn_active: this.yawn_active,
      yawn_count_window: this.yawns.count(t),
      nod_count_window: this.nods.count(t),
      score,
      level,
      perclos_advisory: advisory,
      events,
    };
    return this.state;
  }
}

const { pyRound } = require('./util');
function roundTo(x, d) {
  return pyRound(x, d);
}

module.exports = { LEVELS, ADVISORY_REPEAT_S, DrowsinessTracker, emptyDrowsinessState, clip };
