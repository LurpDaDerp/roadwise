// Tuning constants for the scoring engine (spec Appendix A).
//
// This package runs both on device (Metro) and inside a Supabase edge function (Deno), so it must
// stay dependency-free: no imports from `src/`, no `@/` alias, no React Native, no Node built-ins.
// The mph → m/s and mile → m conversions are therefore written out here instead of imported from
// `src/lib/units`.

const MPH = 0.44704;
const MILE = 1609.344;

export type EventCategory = 'phone' | 'speeding' | 'braking' | 'accel' | 'cornering' | 'focus';

/** Base weight `B` and per-trip deduction cap per category (§9.3). Caps sum to 100. */
export const CATEGORY: Record<EventCategory, { base: number; cap: number }> = {
  phone: { base: 8, cap: 30 },
  speeding: { base: 2, cap: 25 },
  braking: { base: 3, cap: 12 },
  accel: { base: 2, cap: 8 },
  cornering: { base: 2.5, cap: 10 },
  focus: { base: 3, cap: 15 },
};

/** Drowsiness episodes carry a heavier base than the rest of the focus category (§9.3). */
export const DROWSINESS_BASE = 6;

export const CONSTANTS = {
  MPH,
  MILE,
  CATEGORY,
  LOCKOUT_SPEED_MPS: 5 * MPH,
  STOPPED_PANEL_S: 3,
  AUTO_END_STATIONARY_S: 300,
  GAP_MERGE_S: 600,
  MIN_SCORED_DISTANCE_M: 0.5 * MILE,
  MIN_SCORED_DURATION_S: 120,
  AUTO_DETECT_CONFIRM_SPEED_MPS: 12 * MPH,
  AUTO_DETECT_CONFIRM_S: 30,
  AUTO_DETECT_WINDOW_S: 180,
  SPEEDING_TOLERANCE_MPS: 5 * MPH,
  SPEEDING_MIN_S: 5,
  SPEEDING_GRACE_S: 10,
  GLANCE_GRACE_S: 1.5,
  HARSH_BRAKE_G: 0.30,
  HARSH_BRAKE_MIN_S: 0.5,
  HARSH_ACCEL_G: 0.28,
  HARSH_ACCEL_MIN_S: 1,
  HARSH_CORNER_G: 0.35,
  CORNER_MIN_SPEED_MPS: 15 * MPH,
  PHONE_HANDLING_MIN_S: 3,
  PHONE_MIN_SPEED_MPS: 10 * MPH,
  EYES_OFF_S: 2,
  EYES_OFF_MIN_SPEED_MPS: 10 * MPH,
  EXPOSURE_FLOOR: 0.75,
  Q_UNSCORED_BELOW: 0.5,
  Q_FULL_AT: 0.8,
  CONTEXT_NIGHT: 1.2,
  CONTEXT_PRECIP: 1.25,
  CONTEXT_CAP: 1.5,
  NIGHT_START_H: 23,
  NIGHT_END_H: 5,
  LONG_TERM_WINDOW_D: 60,
  LONG_TERM_HALF_LIFE_D: 21,
  LONG_TERM_K0: 2,
  LONG_TERM_MU0: 80,
  LONG_TERM_MIN_TRIPS: 3,
  LONG_TERM_MIN_MINUTES: 60,
  LONG_TERM_FALLBACK_TRIPS: 10,
  LONG_TERM_MAX_D: 180,
  LONG_TERM_EXPOSURE_CAP: 3,
  SAFE_DAY_AVG: 85,
  GOOD_DAY_AVG: 70,
  SAFE_DAY_MIN_DRIVING_S: 600,
  SEVERE_SPEEDING_OVER_MPS: 20 * MPH,
  SHIELD_EVERY_SAFE_DAYS: 14,
  SHIELD_MAX: 2,
  DISPUTES_PER_7D: 3,
  DISPUTES_MAX_PCT_30D: 20,
  ALERT_BUDGET_L1_PER_10MIN: 6,
  ALERT_BUDGET_WINDOW_S: 600,
  LEARNING_PERIOD_TRIPS: 3,
  ALERT_L1_SPEEDING_MIN_S: 5,
  ALERT_L2_OVER_MPS: 15 * MPH,
  ALERT_L2_PERSIST_S: 30,
  ALERT_L3_OVER_MPS: 20 * MPH,
  ALERT_L3_MIN_S: 10,
  ALERT_REALERT_S: 120,
  ALERT_PHONE_COOLDOWN_S: 60,
  ALERT_DROWSY_MAX_PER_S: 600,
  CHECKPOINT_S: 30,
  DISCARD_SPEED_MPS: 100 * MPH,
  DATA_QUALITY_A_PCT: 90,
  DATA_QUALITY_B_PCT: 70,
  POINTS: {
    safeDay: 50,
    goodDay: 20,
    phoneFreeDay: 25,
    cameraDay: 10,
    weeklyGoal: 150,
    referral: 500,
  },
} as const;
