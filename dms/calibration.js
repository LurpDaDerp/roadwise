'use strict';
/**
 * Forward-gaze calibration: the camera-frame direction of "eyes on the road ahead", found
 * label-free from the gaze stream (`dms/calibration.py`, docs/DESIGN.md §3).
 *
 * Two exponentially forgetting 2-D histograms over the camera-frame gaze angles receive the
 * frames that pass the admission gates.  The long one (tau 300 s) is the reference, the short
 * one (tau 45 s) the shift detector.  Every weight is `w * dt` seconds.
 */

const { Event, EventType } = require('./alerts');
const {
  DecayingHistogram1D,
  DecayingHistogram2D,
  anglesToVector,
  angularDistanceDeg,
  pairwiseSum,
  relativeAngles,
  separableBlur,
  unit,
  vectorToAngles,
} = require('./util');

const Confidence = {
  NONE: 'NONE',
  PROVISIONAL: 'PROVISIONAL',
  CONFIRMED: 'CONFIRMED',
  STALE: 'STALE',
};

function gaussianKernel(sigmaBins) {
  const r = Math.max(1, Math.ceil(2.5 * sigmaBins));
  const k = new Float64Array(2 * r + 1);
  for (let d = -r; d <= r; d++) {
    const q = d / sigmaBins;
    k[d + r] = Math.exp(-0.5 * (q * q));
  }
  const s = pairwiseSum(k, 0, k.length);
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/**
 * `[x, y, share]`: the centre of the densest region of size ~`searchSigmaDeg` (argmax of the
 * histogram blurred with that Gaussian), refined to the mass centroid of the raw counts
 * within `refineRadiusDeg`; `share` is that neighbourhood's share of the total mass.
 */
function robustMode(counts, nx, ny, x0, y0, binDeg, searchSigmaDeg, refineRadiusDeg) {
  const total = pairwiseSum(counts, 0, counts.length);
  if (total <= 0.0) return null;
  const blurred = separableBlur(counts, nx, ny, gaussianKernel(searchSigmaDeg / binDeg));
  let best = -Infinity;
  let arg = 0;
  for (let idx = 0; idx < blurred.length; idx++) {
    if (blurred[idx] > best) {
      best = blurred[idx];
      arg = idx;
    }
  }
  const i = Math.floor(arg / ny);
  const j = arg % ny;
  const r = Math.ceil(refineRadiusDeg / binDeg);
  const i0 = Math.max(0, i - r), i1 = Math.min(nx, i + r + 1);
  const j0 = Math.max(0, j - r), j1 = Math.min(ny, j + r + 1);
  const h = i1 - i0, w = j1 - j0;
  const wArr = new Float64Array(h * w);
  const wI = new Float64Array(h * w);
  const wJ = new Float64Array(h * w);
  const rr = refineRadiusDeg * refineRadiusDeg;
  for (let a = 0; a < h; a++) {
    const ii = i0 + a;
    const di = ii - i;
    for (let b = 0; b < w; b++) {
      const jj = j0 + b;
      const dj = jj - j;
      const inside = ((di * di + dj * dj) * binDeg) * binDeg <= rr ? 1.0 : 0.0;
      const v = counts[ii * ny + jj] * inside;
      wArr[a * w + b] = v;
      wI[a * w + b] = v * ii;
      wJ[a * w + b] = v * jj;
    }
  }
  const ws = pairwiseSum(wArr, 0, wArr.length);
  if (ws <= 0.0) return null;
  const ci = pairwiseSum(wI, 0, wI.length) / ws;
  const cj = pairwiseSum(wJ, 0, wJ.length) / ws;
  return [x0 + (ci + 0.5) * binDeg, y0 + (cj + 0.5) * binDeg, ws / total];
}

/** `sum(dt * exp(-(t_now - t) / tau))`: the decayed seconds of some condition. */
class DecayingScalar {
  constructor(tauS) {
    this.tau = tauS;
    this.value = 0.0;
    this.t_last = null;
  }

  reset() {
    this.value = 0.0;
    this.t_last = null;
  }

  add(t, amount) {
    if (this.t_last !== null && this.tau > 0) {
      this.value *= Math.exp(-Math.max(0.0, t - this.t_last) / this.tau);
    }
    this.t_last = t;
    this.value += Math.max(0.0, amount);
  }
}

class ForwardReference {
  constructor(config) {
    this.cfg = config;
    this.cc = config.calibration;
    this.fe = config.front_end;
    this.max_dt = this.fe.max_dt_s;   // the monitor raises it to dt_clip_period_factor x the frame period
    this.reset();
  }

  // ------------------------------------------------------------------ state
  reset() {
    const cc = this.cc, fe = this.fe;
    this.hist_long = new DecayingHistogram2D(cc.yaw_range, cc.pitch_range, cc.bin_deg, cc.tau_long_s);
    this.hist_short = new DecayingHistogram2D(cc.yaw_range, cc.pitch_range, cc.bin_deg, cc.tau_short_s);
    this.head_hist = new DecayingHistogram2D(cc.yaw_range, cc.pitch_range, cc.bin_deg, cc.tau_head_s);
    this.iris_x_hist = new DecayingHistogram1D(-0.3, 0.3, 0.0025, fe.stat_window_s);
    this.iris_y_hist = new DecayingHistogram1D(-0.3, 0.3, 0.0025, fe.stat_window_s);
    this.aperture_hist = new DecayingHistogram1D(0.0, 0.8, 0.0025, fe.stat_window_s);
    this.iod_hist = new DecayingHistogram1D(0.0, 1.0, 0.002, 60.0);
    this.cx_hist = new DecayingHistogram1D(-0.5, 1.5, 0.005, 60.0);
    this.cy_hist = new DecayingHistogram1D(-0.5, 1.5, 0.005, 60.0);
    this.usable_short = new DecayingScalar(cc.tau_short_s);
    this.recent_admitted = new DecayingScalar(ForwardReference.RECENT_TAU_S);
    this.recent_agree = new DecayingScalar(ForwardReference.RECENT_TAU_S);
    this.shift_mass = 0.0;
    this.reference = null;
    this.confidence = Confidence.NONE;
    this.t_last = null;
    this.t_mode = null;
    this.prev_head_dir = null;
    this.prev_head_t = null;
    this.absent_since = null;
    this.stale_marked = false;
    this.shift_since = null;
    this.geometry_off_since = null;
    this.pre_gap = null;
    this.post_gap = null;          // [t_start, sum_aperture, sum_iris_y, n]
    this.long_mode = null;
    this.short_mode = null;
    this.head_mode_xy = null;
    this.head_mode_vec = null;
    this.concentration = 0.0;
    this.short_concentration = 0.0;
    this._t_ref_move = null;
    this.long_jump_since = null;
    this.short_distance = null;
    this.last_weight = 0.0;
  }

  // ------------------------------------------------------------------ helpers
  _state(events) {
    const [yaw, pitch] = this.reference !== null ? vectorToAngles(this.reference) : [NaN, NaN];
    return {
      reference: this.reference === null ? null : this.reference.slice(),
      yaw,
      pitch,
      confidence: this.confidence,
      admitted_s: this.hist_long.mass(),
      concentration: this.concentration,
      short_distance_deg: this.short_distance,
      head_mode: this.head_mode_xy,
      head_mode_s: this.head_hist.mass(),
      weight: this.last_weight,
      events,
    };
  }

  /** Densest road-sized region of the histogram; returns `[mode, concentration]`. */
  _modeOf(hist) {
    const mass = hist.mass();
    if (mass <= 0.0) return [null, 0.0];
    const m = robustMode(hist.counts, hist.nx, hist.ny, hist.x0, hist.y0, hist.bin,
                         this.cc.search_sigma_deg, this.cc.refine_radius_deg);
    if (m === null) return [null, 0.0];
    const conc = hist.massWithin(m[0], m[1], this.cc.concentration_radius_deg) / mass;
    return [m, conc];
  }

  _replaceWithShort(t, events, detail) {
    const [m, conc] = this._modeOf(this.hist_short);
    if (m === null) return;
    this.hist_long.copyFrom(this.hist_short);
    this.reference = anglesToVector(m[0], m[1]);
    this.long_mode = m;
    this.concentration = conc;
    this.confidence = Confidence.PROVISIONAL;
    this.shift_since = null;
    this.long_jump_since = null;
    this.stale_marked = false;
    this._t_ref_move = t;
    events.push(new Event(EventType.RECALIBRATED, t, t, 0.0, detail,
                          { yaw: round2(m[0]), pitch: round2(m[1]) }));
  }

  /** Keep the reference but demand that fresh frames agree with it (STALE). */
  _enterRevalidation(t) {
    if (this.confidence === Confidence.PROVISIONAL || this.confidence === Confidence.CONFIRMED) {
      this.confidence = Confidence.STALE;
    }
    this.hist_short.reset();
    this.usable_short.reset();
    this.shift_since = null;
  }

  // ------------------------------------------------------------------ update
  /**
   * One frame.  `speedKmh` (optional, null = unknown) only feeds the phone option
   * `calibration.stationary_weight`: while the speed is known and below
   * `alerts.speed_gate_kmh` the admission weight is multiplied by it (1.0 = the reference).
   */
  update(t, gazeVec, quality, feat, speedKmh = null) {
    const events = [];
    const cc = this.cc;
    const dt = this.t_last === null ? 0.0 : Math.min(Math.max(0.0, t - this.t_last), this.max_dt);
    this.t_last = t;
    this.last_weight = 0.0;
    const facePresent = Boolean(quality && quality.face_present);

    // --- face gaps: STALE after a long absence, driver check after a short one -------
    if (!facePresent) {
      if (this.absent_since === null) {
        this.absent_since = t;
        const mass = this.aperture_hist.mass();
        if (mass >= 30.0) {
          const ap = this.aperture_hist.median();
          const iy = this.iris_y_hist.median();
          this.pre_gap = ap !== null && iy !== null ? [ap, iy] : null;
        }
      } else if ((t - this.absent_since) >= cc.absent_stale_s && !this.stale_marked) {
        this.stale_marked = true;
        if (this.confidence === Confidence.PROVISIONAL || this.confidence === Confidence.CONFIRMED) {
          this._enterRevalidation(t);
          events.push(new Event(EventType.REFERENCE_STALE, t, this.absent_since, t - this.absent_since, 'face absent'));
        }
      }
      return this._state(events);
    }
    if (this.absent_since !== null) {
      const gap = t - this.absent_since;
      this.absent_since = null;
      if (gap >= ForwardReference.GAP_CHECK_MIN_S && this.pre_gap !== null) {
        this.post_gap = [t, 0.0, 0.0, 0];
      }
      if (gap >= cc.absent_stale_s) {
        this.head_hist.reset();
        this.iris_x_hist.reset();
        this.iris_y_hist.reset();
        this.head_mode_vec = null;
        this.head_mode_xy = null;
        for (const h of [this.iod_hist, this.cx_hist, this.cy_hist]) h.reset();
        this.geometry_off_since = null;
      }
      this.prev_head_dir = null;
    }
    this.stale_marked = false;

    // --- head speed ------------------------------------------------------------
    const headDir = feat && feat.head_dir !== undefined ? feat.head_dir : null;
    let headSpeed = 0.0;
    if (headDir !== null && this.prev_head_dir !== null && this.prev_head_t !== null) {
      const hdt = t - this.prev_head_t;
      if (hdt > 1e-3) headSpeed = angularDistanceDeg(headDir, this.prev_head_dir) / hdt;
    }
    if (headDir !== null) {
      this.prev_head_dir = [headDir[0], headDir[1], headDir[2]];
      this.prev_head_t = t;
    }

    // --- geometry (camera / seat moved) ------------------------------------------
    const iod = feat && feat.iod !== undefined ? feat.iod : NaN;
    const center = feat ? feat.eye_center : null;
    let headTurned = false;
    if (headDir !== null) {
      const hd = this.headDeviation(headDir);
      headTurned = hd !== null && Number.isFinite(hd[0]) && hd[0] >= 20.0;
    }
    const centerFinite = center !== null && center !== undefined
      && Number.isFinite(center[0]) && Number.isFinite(center[1]);
    if (Number.isFinite(iod) && centerFinite && !headTurned) {
      this.iod_hist.add(iod, t, dt);
      this.cx_hist.add(center[0], t, dt);
      this.cy_hist.add(center[1], t, dt);
      if (this.iod_hist.mass() >= 20.0) {
        const iodMed = this.iod_hist.median();
        const cxMed = this.cx_hist.median();
        const cyMed = this.cy_hist.median();
        const off = Math.abs(iod / Math.max(iodMed, 1e-6) - 1.0) > cc.geometry_iod_change
          || Math.hypot(center[0] - cxMed, center[1] - cyMed) > cc.geometry_center_shift;
        if (off) {
          if (this.geometry_off_since === null) {
            this.geometry_off_since = t;
          } else if (t - this.geometry_off_since >= cc.geometry_persist_s) {
            events.push(new Event(EventType.CAMERA_MOVED, t, this.geometry_off_since, t - this.geometry_off_since));
            this.geometry_off_since = null;
            for (const h of [this.iod_hist, this.cx_hist, this.cy_hist]) h.reset();
            this.head_hist.reset();
            this._enterRevalidation(t);
          }
        } else {
          this.geometry_off_since = null;
        }
      }
    }

    // --- admission -----------------------------------------------------------------
    const usable = Boolean(quality && quality.usable) && Boolean(quality && quality.eyes_open);
    const inFrame = quality && quality.in_frame_fraction !== undefined ? quality.in_frame_fraction : 0.0;
    const ix = feat && feat.iris_x_in_eye !== undefined ? feat.iris_x_in_eye : NaN;
    const iy = feat && feat.iris_y_in_aperture !== undefined ? feat.iris_y_in_aperture : NaN;
    const ap = feat && feat.aperture !== undefined ? feat.aperture : NaN;
    const eyesOpen = Boolean(quality && quality.eyes_open);
    if (eyesOpen && Number.isFinite(ap)) this.aperture_hist.add(ap, t, dt);
    if (this.post_gap !== null && eyesOpen && Number.isFinite(ap) && Number.isFinite(iy)) {
      this.post_gap[1] += ap;
      this.post_gap[2] += iy;
      this.post_gap[3] += 1;
      if (t - this.post_gap[0] >= ForwardReference.GAP_CHECK_COLLECT_S && this.post_gap[3] >= 10) {
        const apNew = this.post_gap[1] / this.post_gap[3];
        const iyNew = this.post_gap[2] / this.post_gap[3];
        const apOld = this.pre_gap[0], iyOld = this.pre_gap[1];
        this.post_gap = null;
        if (Math.abs(apNew - apOld) > ForwardReference.GAP_APERTURE_JUMP
            || Math.abs(iyNew - iyOld) > cc.stat_jump_eye_widths) {
          events.push(new Event(EventType.DRIVER_CHANGE, t, t - ForwardReference.GAP_CHECK_COLLECT_S,
                                Math.max(Math.abs(apNew - apOld), Math.abs(iyNew - iyOld)), 'statistics jump'));
          this._driverChange(t);
        }
      }
    }
    let admitted = false;
    let w = 0.0;
    if (gazeVec !== null && gazeVec !== undefined && usable && inFrame >= cc.min_in_frame_fraction
        && headSpeed <= cc.max_head_speed_deg_s && Number.isFinite(ix) && Number.isFinite(iy) && dt > 0.0) {
      w = 1.0;
      if (this.iris_x_hist.mass() >= 10.0) {
        const mx = this.iris_x_hist.median();
        const my = this.iris_y_hist.median();
        const ex = Math.max(0.0, Math.abs(ix - mx) - cc.iris_band_x) / cc.iris_sigma_x;
        const ey = Math.max(0.0, Math.abs(iy - my) - cc.iris_band_y) / cc.iris_sigma_y;
        w = Math.exp(-0.5 * (ex * ex + ey * ey));
      }
      const floor = Math.max(w, 0.3) * dt;
      this.iris_x_hist.add(ix, t, floor);
      this.iris_y_hist.add(iy, t, floor);
      const w3 = w;
      if (this.head_mode_vec !== null && headDir !== null && this.head_hist.mass() >= cc.head_mode_min_s) {
        const dHead = angularDistanceDeg(headDir, this.head_mode_vec);
        const q = dHead / cc.head_sigma_deg;
        w *= Math.max(cc.head_weight_floor, Math.exp(-0.5 * (q * q)));
      }
      // phone option: a parked driver holding a neutral gaze must not bootstrap the reference
      if (cc.stationary_weight !== 1.0 && speedKmh !== null && speedKmh !== undefined
          && Number.isFinite(speedKmh) && speedKmh < this.cfg.alerts.speed_gate_kmh) {
        w *= cc.stationary_weight;
      }
      if (w3 >= cc.min_weight && headDir !== null) {
        const [hy, hp] = vectorToAngles(headDir);
        this.head_hist.add(hy, hp, t, w3 * dt);
      }
      if (w >= cc.min_weight) {
        const [gy, gp] = vectorToAngles(gazeVec);
        this.hist_long.add(gy, gp, t, w * dt);
        this.hist_short.add(gy, gp, t, w * dt);
        admitted = true;
        let agree = 0.0;
        if (this.short_mode !== null) {
          const atShort = angularDistanceDeg(gazeVec, anglesToVector(this.short_mode[0], this.short_mode[1])) <= cc.recal_agree_deg;
          agree = atShort ? w * dt : 0.0;
        }
        this.recent_admitted.add(t, w * dt);
        this.recent_agree.add(t, agree);
        if (this.shift_since !== null) this.shift_mass += agree;
      }
    } else if (eyesOpen && Number.isFinite(ix) && Number.isFinite(iy) && dt > 0.0) {
      this.iris_x_hist.add(ix, t, 0.3 * dt);
      this.iris_y_hist.add(iy, t, 0.3 * dt);
    }
    if (usable && dt > 0.0) this.usable_short.add(t, dt);
    if (!admitted && dt > 0.0) {
      this.recent_admitted.add(t, 0.0);
      this.recent_agree.add(t, 0.0);
    }
    this.last_weight = admitted ? w : 0.0;

    // --- modes and confidence (rate limited) ----------------------------------------
    if (this.t_mode === null || t - this.t_mode >= ForwardReference.MODE_INTERVAL_S) {
      this.t_mode = t;
      this._updateModes(t, events);
    }
    return this._state(events);
  }

  /** A different driver: keep only what the new driver's frames produced so far. */
  _driverChange(t) {
    const short = this.hist_short;
    this.reset();
    this.t_last = t;
    this.hist_short = short;
    this.hist_long.copyFrom(short);
  }

  _updateModes(t, events) {
    const cc = this.cc;
    const hm = this.head_hist.mass() >= cc.head_mode_min_s ? this.head_hist.mode(cc.smooth_sigma_bins) : null;
    if (hm !== null) {
      this.head_mode_xy = [hm[0], hm[1]];
      this.head_mode_vec = anglesToVector(hm[0], hm[1]);
    }
    const [longMode, cLong] = this._modeOf(this.hist_long);
    const [shortMode, cShort] = this._modeOf(this.hist_short);
    this.long_mode = longMode;
    this.short_mode = shortMode;
    this.concentration = cLong;
    this.short_concentration = cShort;
    const massLong = this.hist_long.mass();
    const massShort = this.hist_short.mass();
    this.short_distance = null;
    if (longMode === null) return;
    const longVec = anglesToVector(longMode[0], longMode[1]);
    const shortVec = shortMode !== null ? anglesToVector(shortMode[0], shortMode[1]) : null;
    if (shortVec !== null && this.reference !== null && massShort >= ForwardReference.SHORT_MIN_MASS_S) {
      this.short_distance = angularDistanceDeg(shortVec, this.reference);
    }
    const admittedFraction = massShort / Math.max(this.usable_short.value, 1e-6);

    if (this.confidence === Confidence.NONE) {
      if (massLong >= cc.provisional_min_s && cLong >= cc.provisional_min_concentration) {
        this.reference = longVec;
        this.confidence = Confidence.PROVISIONAL;
        events.push(new Event(EventType.CALIBRATION_PROVISIONAL, t, t, massLong, '',
                              { yaw: round2(longMode[0]), pitch: round2(longMode[1]) }));
      }
      return;
    }

    if (this.confidence === Confidence.STALE) {
      if (shortVec !== null && massShort >= cc.fast_replace_min_s && cShort >= cc.recal_min_concentration) {
        const d = angularDistanceDeg(shortVec, this.reference);
        if (d <= cc.stale_agree_deg) {
          if (massShort >= cc.stale_revalidate_s) {
            this.confidence = Confidence.PROVISIONAL;
            this._t_ref_move = t;
            events.push(new Event(EventType.CALIBRATION_PROVISIONAL, t, t, massShort, 'revalidated'));
          }
        } else if (admittedFraction >= cc.recal_min_admitted_fraction) {
          this._replaceWithShort(t, events, 'stale reference disagreed');
        }
      }
      if (this.confidence === Confidence.STALE && longVec !== null && massLong >= cc.provisional_min_s) {
        const dLong = angularDistanceDeg(longVec, this.reference);
        if (dLong <= cc.stale_agree_deg) {
          this.confidence = Confidence.PROVISIONAL;
          this._t_ref_move = t;
          this.long_jump_since = null;
          events.push(new Event(EventType.CALIBRATION_PROVISIONAL, t, t, massLong, 'revalidated (long mode)'));
        } else if (dLong > cc.recal_shift_deg) {
          if (this.long_jump_since === null) {
            this.long_jump_since = t;
          } else if (t - this.long_jump_since >= cc.long_jump_persist_s) {
            this.reference = longVec;
            this.long_jump_since = null;
            this.confidence = Confidence.PROVISIONAL;
            this._t_ref_move = t;
            events.push(new Event(EventType.RECALIBRATED, t, t - cc.long_jump_persist_s, dLong, 'stale: long mode moved',
                                  { yaw: round2(longMode[0]), pitch: round2(longMode[1]) }));
          }
        } else {
          this.long_jump_since = null;
        }
      }
      return;
    }

    // PROVISIONAL / CONFIRMED
    const dLong = angularDistanceDeg(this.reference, longVec);
    if (dLong > cc.recal_shift_deg) {
      if (this.long_jump_since === null) {
        this.long_jump_since = t;
      } else if (t - this.long_jump_since >= cc.long_jump_persist_s) {
        this.reference = longVec;
        this.long_jump_since = null;
        this.confidence = Confidence.PROVISIONAL;
        events.push(new Event(EventType.RECALIBRATED, t, t - cc.long_jump_persist_s, dLong, 'long mode moved',
                              { yaw: round2(longMode[0]), pitch: round2(longMode[1]) }));
      }
    } else {
      this.long_jump_since = null;
    }
    this.reference = ForwardReference._toward(
      this.reference, longVec,
      this._t_ref_move !== null ? cc.max_reference_rate_deg_s * (t - this._t_ref_move) : null);
    this._t_ref_move = t;
    if (this.confidence === Confidence.PROVISIONAL && massLong >= cc.confirmed_min_s && cLong >= cc.confirmed_min_concentration
        && shortVec !== null && massShort >= ForwardReference.SHORT_MIN_MASS_S
        && angularDistanceDeg(shortVec, longVec) <= cc.confirmed_agreement_deg) {
      this.confidence = Confidence.CONFIRMED;
      events.push(new Event(EventType.CALIBRATION_CONFIRMED, t, t, massLong, '',
                            { yaw: round2(longMode[0]), pitch: round2(longMode[1]) }));
    }
    const shifted = shortVec !== null && massShort >= cc.fast_replace_min_s && cShort >= cc.recal_min_concentration
      && admittedFraction >= cc.recal_min_admitted_fraction
      && angularDistanceDeg(shortVec, this.reference) > cc.recal_shift_deg;
    const recent = this.recent_admitted.value;
    const recentAgreeFraction = recent > 1e-6 ? this.recent_agree.value / recent : 0.0;
    if (shifted) {
      if (this.shift_since === null) {
        this.shift_since = t;
        this.shift_mass = 0.0;
      } else if (recent >= 2.0 && recentAgreeFraction < 0.3) {
        this.shift_since = null;
      } else if (t - this.shift_since >= cc.recal_persist_s && this.shift_mass >= 0.3 * cc.recal_persist_s) {
        this._replaceWithShort(t, events, 'persistent shift');
      }
    } else {
      this.shift_since = null;
    }
  }

  /**
   * Start from a persisted reference (DETECTION_DESIGN §5.2): the vector is installed as a STALE
   * reference, so the engine's own re-validation path either confirms it from ~15-20 s of
   * agreeing frames or replaces it (RECALIBRATED) when the mount moved.  Nothing in that path is
   * changed by this call.
   *
   * @param {number[]} referenceVec  the stored forward direction (any length; normalised here)
   * @param {number[]|null} headModeYawPitch  `[yaw, pitch]` degrees of the stored resting head
   *   pose.  When given, the head histogram is seeded with `head_mode_min_s` seconds of mass at
   *   that bin AND `head_mode_xy` / `head_mode_vec` are set, so the head gate and the A6 head
   *   rules work from the first frame instead of after 15 s; `_updateModes` then refines the mode
   *   from real frames and the seed decays away (tau_head_s).
   * @param {number} t  the timestamp the seeded mass is dated at (default: the last frame, else 0)
   */
  seedStale(referenceVec, headModeYawPitch = null, t = null) {
    const t0 = t === null || t === undefined ? (this.t_last === null ? 0.0 : this.t_last) : t;
    this.reference = unit(referenceVec);
    this.confidence = Confidence.STALE;
    this.stale_marked = false;
    this.long_jump_since = null;
    this._t_ref_move = null;
    // the same short-state clearing `_enterRevalidation` does
    this.hist_short.reset();
    this.usable_short.reset();
    this.shift_since = null;
    this.shift_mass = 0.0;
    if (headModeYawPitch !== null && headModeYawPitch !== undefined) {
      const [yaw, pitch] = headModeYawPitch;
      this.head_hist.add(yaw, pitch, t0, this.cc.head_mode_min_s);
      this.head_mode_xy = [yaw, pitch];
      this.head_mode_vec = anglesToVector(yaw, pitch);
    }
  }

  /** Rotate `current` toward `target` by at most `maxDeg` (null = jump). */
  static _toward(current, target, maxDeg) {
    if (current === null || maxDeg === null) return target;
    const d = angularDistanceDeg(current, target);
    if (d <= maxDeg || d < 1e-9) return target;
    const f = maxDeg / d;
    const a = unit(current), b = unit(target);
    return unit([(1.0 - f) * a[0] + f * b[0], (1.0 - f) * a[1] + f * b[1], (1.0 - f) * a[2] + f * b[2]]);
  }

  // ------------------------------------------------------------------ queries
  relativeAngles(gazeVec) {
    if (this.reference === null) return null;
    return relativeAngles(gazeVec, this.reference);
  }

  /** `[angle_deg, pitch_dev_deg]` of the head direction against the head mode (null if unknown). */
  headDeviation(headDir) {
    if (headDir === null || headDir === undefined || this.head_mode_vec === null
        || this.head_hist.mass() < this.cc.head_mode_min_s) {
      return null;
    }
    const [, dpitch] = relativeAngles(headDir, this.head_mode_vec);
    return [angularDistanceDeg(headDir, this.head_mode_vec), dpitch];
  }
}

ForwardReference.GAP_CHECK_MIN_S = 5.0;        // a face gap at least this long triggers the post-gap driver check
ForwardReference.GAP_CHECK_COLLECT_S = 20.0;   // seconds of post-gap frames compared against the pre-gap medians
ForwardReference.GAP_APERTURE_JUMP = 0.04;     // eye widths: a different lid geometry
ForwardReference.MODE_INTERVAL_S = 0.5;        // how often the histogram modes are recomputed
ForwardReference.SHORT_MIN_MASS_S = 10.0;      // short mode needs this much mass before it is trusted
ForwardReference.RECENT_TAU_S = 10.0;          // window of the "recently admitted frames agree" test

const { pyRound } = require('./util');
function round2(x) {
  return pyRound(x, 2);
}

module.exports = { Confidence, robustMode, gaussianKernel, DecayingScalar, ForwardReference };
