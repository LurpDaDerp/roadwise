'use strict';
/**
 * The PHONE configuration of the rule engine: the reference defaults (`config.js`, parity-tested
 * against the Python stack) plus the phone-specific changes of docs/dms/DETECTION_DESIGN.md
 * (§5 calibration, §6 hard limits, §7 sensitivity, §7a drowsiness).  Every change is a config
 * field whose default in `config.js` reproduces the reference behaviour.
 *
 *   createAppConfig({ sensitivity: 'standard' | 'relaxed', driverSide: 'left' | 'right',
 *                     focalScale, imageRightIsDriverLeft })
 */

const { createConfig } = require('./config');

/**
 * DETECTION_DESIGN §7: "standard" = the reference (Euro NCAP) values; "relaxed" applies the
 * regulatory upper bounds (ADDW); "strict" warns earlier but never below the NHTSA 2-s risk onset.
 * The app's settings names map low -> relaxed, medium -> standard, high -> strict.
 */
const SENSITIVITY_PROFILES = {
  standard: {},
  relaxed: {
    attention: {
      long_glance_s: 3.5,          // ADDW: Area 3 for 3.5 s at >= 50 km/h
      lateral_glance_moving_s: 6.0, // ADDW: 6 s at 20-50 km/h
      vats_offroad_s: 12.0,        // NHTSA per-task eyes-off-road budget
    },
  },
  strict: {
    attention: {
      long_glance_s: 2.5,          // between the NHTSA 2-s risk onset and Euro NCAP's 3 s
      long_glance_mirror_s: 3.5,
      lateral_glance_moving_s: 3.0,
      lateral_glance_s: 8.0,
      vats_offroad_s: 8.0,
    },
    drowsiness: {
      perclos_drowsy: 0.12,        // the DDWS field-trial warning level
    },
  },
};
const SENSITIVITY_ALIASES = { low: 'relaxed', medium: 'standard', high: 'strict' };

/** The phone deltas from the reference (DETECTION_DESIGN §5, §6, §7a; RESEARCH §8). */
function phoneOverrides() {
  return {
    front_end: {
      extraction: 'task_graph',    // the phone runs the single-pass FaceLandmarker (NATIVE_LAYER.md)
    },
    calibration: {
      stationary_weight: 0.25,     // admission weight while the vehicle is known to be below the speed gate
    },
    attention: {
      hard_left_driver_deg: 75.0,     // driver's side: the DRIVER_WINDOW boundary (intersections)
      hard_left_passenger_deg: 65.0,  // passenger's side: beyond the mirror (~46) and glovebox (~53)
    },
    drowsiness: {
      long_blink_s: 0.5,           // Johns 2003 / Wilkinson 2013: drowsy blinks > 500 ms
      slow_blink_mean_s: 0.5,
      slow_blink_min_count: 10,
      score_long_blink_share: 30.0,
      ear_open_freeze_s: 120.0,    // floor the open-eye baseline at 0.9 x the alert median after 120 s
      ear_open_freeze_ratio: 0.9,
      perclos_blink_exclude_s: 0.25, // closures shorter than this leave the PERCLOS accumulators
      blink_stats_min_fps: 15.0,   // blink statistics report 0 below this frame rate
      perclos_advisory: 0.08,      // display-only "consider a break" hint (60-s PERCLOS)
    },
  };
}

/**
 * Build the phone configuration.
 * @param {object} opts
 *   sensitivity: 'standard' (default, the reference values) | 'relaxed' | 'strict' (or low/medium/high)
 *   driverSide: 'left' (LHD, default) | 'right'
 *   focalScale: fx / width of the upright frame (from the native layer; default 0.75)
 *   imageRightIsDriverLeft: true for an un-mirrored capture of a driver facing the camera
 */
function createAppConfig(opts = {}) {
  const requested = SENSITIVITY_ALIASES[opts.sensitivity] || opts.sensitivity;
  const sensitivity = requested && SENSITIVITY_PROFILES[requested] ? requested : 'standard';
  const overrides = phoneOverrides();
  overrides.attention.driver_side = opts.driverSide === 'right' ? 'right' : 'left';
  if (typeof opts.imageRightIsDriverLeft === 'boolean') {
    overrides.attention.image_right_is_driver_left = opts.imageRightIsDriverLeft;
  }
  if (Number.isFinite(opts.focalScale) && opts.focalScale > 0) overrides.front_end.focal_scale = opts.focalScale;
  const profile = SENSITIVITY_PROFILES[sensitivity];
  for (const section of Object.keys(profile)) {
    overrides[section] = Object.assign({}, overrides[section] || {}, profile[section]);
  }
  return createConfig(overrides);
}

module.exports = { createAppConfig, phoneOverrides, SENSITIVITY_PROFILES, SENSITIVITY_ALIASES };
