'use strict';
/**
 * Single source of truth for every threshold of the driver monitoring stack.
 *
 * Plain-JS port of `dms/config.py`.  Config FIELD names keep the Python snake_case spelling
 * (so fixtures, the C header and docs line up); functions and classes are camelCase.
 * Every value is in SI units (seconds, degrees, unit-less ratios).
 */

/**
 * A gaze zone in driver terms relative to the forward reference.
 * `left` / `up` are inclusive `[lo, hi]` degree ranges (driver's left positive, up positive);
 * `null` means unbounded on that side.  `kind` is one of `road`, `road_wide`, `mirror`,
 * `instrument`, `secondary`, `far`, `other`.  Ellipse zones use `left[0]` / `up[0]` as
 * semi-axes centred on the reference (`center_up` shifts the centre vertically).
 */
function zone(name, kind, left = [null, null], up = [null, null], ellipse = false, centerUp = 0.0) {
  return { name, kind, left, up, ellipse, center_up: centerUp };
}

/** Left-hand-drive passenger car, camera facing the driver (docs/DESIGN.md §5). */
function defaultZones() {
  return [
    zone('ROAD', 'road', [15.0, 15.0], [10.0, 10.0], true),
    zone('ROAD_WIDE', 'road_wide', [22.0, 22.0], [14.0, 14.0], true),
    zone('REARVIEW_MIRROR', 'mirror', [-45.0, -15.0], [5.0, 25.0]),
    zone('LEFT_MIRROR', 'mirror', [35.0, 75.0], [-15.0, 5.0]),
    zone('RIGHT_MIRROR', 'mirror', [-80.0, -40.0], [-15.0, 5.0]),
    zone('CLUSTER', 'instrument', [-20.0, 20.0], [-32.0, -12.0]),
    zone('CENTER_STACK', 'secondary', [-55.0, -15.0], [-40.0, -12.0]),
    zone('LAP', 'far', [-30.0, 30.0], [null, -32.0]),
    zone('PASSENGER', 'far', [-95.0, -40.0], [-12.0, 15.0]),
    zone('DRIVER_WINDOW', 'far', [75.0, null], [-20.0, 20.0]),
    zone('UP', 'far', [null, null], [25.0, null]),
  ];
}

function defaultFrontEnd() {
  return {
    focal_scale: 0.75,
    tta: false,
    extraction: 'mesh_roi',
    min_in_frame_fraction: 0.9,
    stat_warmup_frames: 30,
    stat_window_s: 120.0,
    stat_hist_lo: -0.2,
    stat_hist_hi: 0.2,
    stat_hist_bin: 0.0025,
    gaze_median_window_s: 0.15,
    gaze_max_age_s: 1.0,
    dt_clip_period_factor: 2.5,
    dt_gap_factor: 6.0,
    max_dt_s: 0.5,
  };
}

function defaultCalibration() {
  return {
    yaw_range: [-70.0, 70.0],
    pitch_range: [-50.0, 50.0],
    bin_deg: 1.0,
    smooth_sigma_bins: 1.5,
    search_sigma_deg: 4.0,
    refine_radius_deg: 5.0,
    max_reference_rate_deg_s: 0.1,
    long_jump_persist_s: 60.0,
    tau_long_s: 300.0,
    tau_short_s: 45.0,
    max_head_speed_deg_s: 40.0,
    min_in_frame_fraction: 0.95,
    iris_band_x: 0.03,
    iris_sigma_x: 0.03,
    iris_band_y: 0.02,
    iris_sigma_y: 0.02,
    min_weight: 0.05,
    head_sigma_deg: 10.0,
    head_weight_floor: 0.15,
    tau_head_s: 120.0,
    head_mode_min_s: 15.0,
    concentration_radius_deg: 5.0,
    provisional_min_s: 15.0,
    provisional_min_concentration: 0.5,
    confirmed_min_s: 60.0,
    confirmed_min_concentration: 0.55,
    confirmed_agreement_deg: 3.0,
    recal_shift_deg: 6.0,
    recal_persist_s: 60.0,
    recal_min_concentration: 0.35,
    recal_min_admitted_fraction: 0.6,
    recal_agree_deg: 8.0,
    absent_stale_s: 60.0,
    stale_agree_deg: 6.0,
    stale_revalidate_s: 20.0,
    fast_replace_min_s: 15.0,
    geometry_iod_change: 0.25,
    geometry_center_shift: 0.15,
    geometry_persist_s: 10.0,
    stat_jump_eye_widths: 0.02,
    // phone option (DETECTION_DESIGN §5.1): the admission weight is multiplied by this while the
    // vehicle speed is known and below alerts.speed_gate_kmh.  1.0 = the reference behaviour.
    stationary_weight: 1.0,
  };
}

function defaultAttention() {
  return {
    image_right_is_driver_left: true,
    driver_side: 'left',
    provisional_margin_deg: 5.0,
    rel_yaw_gain: 1.0,
    rel_pitch_gain: 1.0,
    hard_left_deg: 60.0,
    // phone option (DETECTION_DESIGN §6): an ASYMMETRIC lateral bound in DRIVER terms
    // (positive left = the driver's side).  null = fall back to hard_left_deg (the reference).
    hard_left_driver_deg: null,
    hard_left_passenger_deg: null,
    hard_down_deg: -30.0,
    hard_up_deg: 30.0,
    far_glance_confirm_s: 0.4,
    phone_pattern_count: 3,
    phone_glance_min_s: 0.6,
    phone_pattern_window_s: 30.0,
    long_glance_s: 3.0,
    long_glance_mirror_s: 4.0,
    lateral_glance_s: 12.0,
    lateral_glance_moving_s: 4.0,
    lateral_speed_kmh: 30.0,
    glance_gap_tolerance_s: 0.3,
    escalation_s: 2.0,
    stare_after_s: 3.0,
    look_down_deg: 12.0,
    look_down_exit_deg: 9.0,
    look_up_deg: 20.0,
    look_up_exit_deg: 15.0,
    look_filter_s: 1.0,
    lateral_head_min_deg: 10.0,
    exposure_window_s: 60.0,
    exposure_w_driving_task: 0.25,
    exposure_w_lateral: 0.5,
    exposure_w_cabin: 1.0,
    exposure_long_factor: 2.0,
    exposure_long_after_s: 2.0,
    glance_count_min_s: 0.3,
    vats_window_s: 30.0,
    vats_offroad_s: 10.0,
    vats_mirror_ignore_s: 1.0,
    attend_buffer_s: 2.0,
    attend_mirror_delay_s: 1.0,
    attend_refill_latency_s: 0.1,
    prc_window_s: 60.0,
    prc_cone_deg: 8.0,
    prc_concentration: 0.92,
    prc_max_sd_deg: 3.0,
    mirror_check_s: 300.0,
    head_turn_deg: 35.0,
    head_down_deg: 20.0,
    head_rule_s: 2.0,
    head_rule_audible_s: 4.0,
    head_mode_min_s: 15.0,
  };
}

function defaultDrowsiness() {
  return {
    ear_open_percentile: 50.0,
    ear_window_s: 120.0,
    ear_closed_ratio: 0.35,
    ear_hist_lo: 0.0,
    ear_hist_hi: 0.8,
    ear_hist_bin: 0.005,
    close_enter: 0.3,
    close_exit: 0.5,
    eyes_open_threshold: 0.5,
    perclos_closed: 0.2,
    blink_min_s: 0.06,
    blink_max_s: 0.5,
    long_blink_s: 0.4,
    prolonged_closure_s: 0.5,
    prolonged_closure_alert_s: 1.0,
    microsleep_s: 1.5,
    sleep_s: 3.0,
    eyes_closed_s: 6.0,
    microsleep_repeat_s: 2.0,
    closure_head_turn_deg: 45.0,
    closure_min_frames_low_rate: 3,
    blink_window_s: 60.0,
    slow_blink_mean_s: 0.4,
    slow_blink_min_count: 5,
    perclos_window_s: 60.0,
    perclos_min_usable_s: 30.0,
    perclos_drowsy: 0.15,
    perclos_severe: 0.30,
    yawn_mar: 0.6,
    yawn_mar_exit: 0.4,
    yawn_min_s: 1.5,
    yawn_max_s: 12.0,
    yawn_count: 3,
    yawn_window_s: 600.0,
    nod_drop_deg: 15.0,
    nod_drop_s: 1.0,
    nod_recover_s: 3.0,
    nod_count: 2,
    nod_window_s: 300.0,
    score_drowsy: 50.0,
    score_severe: 75.0,
    ear_open_prior: 0.30,
    ear_near_ratio: 0.85,
    stream_gap_s: 1.0,
    stream_gap_factor: 3.0,
    ear_seed_s: 2.0,
    ear_open_floor: 0.20,
    ear_closed_window_s: 600.0,
    ear_closed_min_mass: 5.0,
    ear_closed_max_ratio: 0.6,
    blink_rate_min_elapsed_s: 10.0,
    slow_blink_repeat_s: 60.0,
    frequent_yawn_repeat_s: 60.0,
    nod_baseline_window_s: 30.0,
    nod_near_deg: 5.0,
    drowsy_repeat_s: 30.0,
    score_window_s: 600.0,
    score_perclos_gain: 250.0,
    score_long_blink_share: 20.0,
    score_yawn: 12.0,
    score_nod: 15.0,
    score_microsleep: 40.0,
    closure_deep_fraction: 0.5,
    perclos_long_window_s: 180.0,
    perclos_long_bucket_s: 1.0,
    perclos_long_min_usable_s: 90.0,
    perclos_long_drowsy: 0.10,
    perclos_recover: 0.08,
    perclos_severe_exit: 0.20,
    score_drowsy_exit: 40.0,
    score_severe_exit: 65.0,
    level_recovery_s: 60.0,
    nod_min_closed_s: 0.3,
    // --- phone options (DETECTION_DESIGN §7a); every default reproduces the reference ---
    ear_open_freeze_s: 0.0,        // > 0: floor the open-eye baseline at ratio x its value after this much usable tracking
    ear_open_freeze_ratio: 0.9,
    perclos_blink_exclude_s: 0.0,  // > 0: a counted closure no longer than this leaves the PERCLOS accumulators
    blink_stats_min_fps: 0.0,      // > 0: blink statistics report 0 when the typical frame period exceeds 1 / this
    perclos_advisory: null,        // 60-s PERCLOS at or above this emits the INFO PERCLOS_ADVISORY (display hint)
  };
}

function defaultAlerts() {
  return {
    driver_absent_s: 5.0,
    driver_absent_alert_s: 10.0,
    alert_cooldown_s: 4.0,
    drowsiness_cooldown_s: 30.0,
    ack_suppress_s: 30.0,
    ack_abuse_count: 3,
    ack_abuse_window_s: 120.0,
    driver_absent_repeat_s: 30.0,
    microsleep_needs_calibration: true,
    speed_gate_kmh: 10.0,
    eyes_unreadable_s: 10.0,
  };
}

/** The reference `DmsConfig()` defaults. */
function defaultConfig() {
  return {
    front_end: defaultFrontEnd(),
    calibration: defaultCalibration(),
    attention: defaultAttention(),
    drowsiness: defaultDrowsiness(),
    alerts: defaultAlerts(),
    zones: defaultZones(),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return overrides;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** `createConfig({attention: {long_glance_s: 4}})` -> the defaults with those fields replaced. */
function createConfig(overrides) {
  const cfg = defaultConfig();
  if (!overrides) return cfg;
  const merged = deepMerge(cfg, overrides);
  if (overrides.zones) merged.zones = overrides.zones.map((z) => Object.assign({}, z));
  return merged;
}

/** Parse a JSON string (or accept an already-parsed object) into a full config. */
function configFromJson(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return createConfig(parsed);
}

/** The reference `DmsConfig.validate()`; throws `Error` on the same conditions. */
function validate(cfg) {
  const a = cfg.attention, c = cfg.calibration, d = cfg.drowsiness;
  if (a.driver_side !== 'left' && a.driver_side !== 'right') {
    throw new Error("attention.driver_side must be 'left' or 'right'");
  }
  if (!(d.close_enter > 0.0 && d.close_enter < d.close_exit && d.close_exit <= 1.0)) {
    throw new Error('drowsiness.close_enter < close_exit in (0, 1]');
  }
  if (!(cfg.front_end.focal_scale > 0.0 && cfg.front_end.max_dt_s > 0.0)) {
    throw new Error('front_end.focal_scale and max_dt_s must be positive');
  }
  if (cfg.front_end.extraction !== 'mesh_roi' && cfg.front_end.extraction !== 'task_graph') {
    throw new Error("front_end.extraction must be 'mesh_roi' or 'task_graph'");
  }
  if (c.tau_short_s >= c.tau_long_s) {
    throw new Error('calibration.tau_short_s must be shorter than tau_long_s');
  }
  if (a.long_glance_s <= a.glance_gap_tolerance_s) {
    throw new Error('attention.long_glance_s must exceed glance_gap_tolerance_s');
  }
  if (!(a.look_down_exit_deg > 0.0 && a.look_down_exit_deg <= a.look_down_deg
        && a.look_up_exit_deg > 0.0 && a.look_up_exit_deg <= a.look_up_deg)) {
    throw new Error('attention: 0 < look_*_exit_deg <= look_*_deg');
  }
  if (!(a.look_filter_s >= 0.0 && a.look_filter_s <= 5.0 && a.lateral_head_min_deg >= 0.0)) {
    throw new Error('attention: look_filter_s in [0, 5] and lateral_head_min_deg >= 0');
  }
  if (!(a.long_glance_s <= a.long_glance_mirror_s && a.lateral_glance_moving_s <= a.lateral_glance_s)) {
    throw new Error('attention: long_glance_s <= long_glance_mirror_s and lateral_glance_moving_s <= lateral_glance_s');
  }
  if (!(d.closure_deep_fraction >= 0.0 && d.closure_deep_fraction <= 1.0
        && d.perclos_long_window_s > d.perclos_window_s && d.perclos_long_bucket_s > 0.0)) {
    throw new Error('drowsiness: closure_deep_fraction in [0, 1], perclos_long_window_s > perclos_window_s, bucket > 0');
  }
  if (!(d.score_drowsy_exit < d.score_drowsy && d.score_drowsy <= d.score_severe_exit
        && d.score_severe_exit < d.score_severe && d.perclos_severe_exit < d.perclos_severe)) {
    throw new Error('drowsiness: exit thresholds must sit below the entry thresholds');
  }
  // --- the phone-only options (DETECTION_DESIGN §5.1, §6, §7a); every reference default passes
  if (!(c.stationary_weight >= 0.0 && c.stationary_weight <= 1.0)) {
    throw new Error('calibration.stationary_weight must be in [0, 1]');
  }
  for (const key of ['hard_left_driver_deg', 'hard_left_passenger_deg']) {
    const v = a[key];
    if (!(v === null || v === undefined || (Number.isFinite(v) && v > 0.0))) {
      throw new Error(`attention.${key} must be null or a positive angle`);
    }
  }
  if (!(d.ear_open_freeze_s >= 0.0)) {
    throw new Error('drowsiness.ear_open_freeze_s must be >= 0 (0 = off)');
  }
  if (!(d.ear_open_freeze_ratio > 0.0 && d.ear_open_freeze_ratio <= 1.0)) {
    throw new Error('drowsiness.ear_open_freeze_ratio must be in (0, 1]');
  }
  if (!(d.perclos_blink_exclude_s >= 0.0)) {
    throw new Error('drowsiness.perclos_blink_exclude_s must be >= 0 (0 = off)');
  }
  if (!(d.blink_stats_min_fps >= 0.0)) {
    throw new Error('drowsiness.blink_stats_min_fps must be >= 0 (0 = off)');
  }
  if (!(d.perclos_advisory === null || d.perclos_advisory === undefined
        || (d.perclos_advisory > 0.0 && d.perclos_advisory < 1.0))) {
    throw new Error('drowsiness.perclos_advisory must be null or in (0, 1)');
  }

  const names = cfg.zones.map((z) => z.name);
  if (names.length !== new Set(names).size) throw new Error('zone names must be unique');
  if (!cfg.zones.some((z) => z.kind === 'road')) throw new Error("a 'road' zone is required");
}

module.exports = {
  zone,
  defaultZones,
  defaultFrontEnd,
  defaultCalibration,
  defaultAttention,
  defaultDrowsiness,
  defaultAlerts,
  defaultConfig,
  createConfig,
  configFromJson,
  deepMerge,
  validate,
  DEFAULT: defaultConfig(),
};
