// Every tunable number of the feature-extraction reference (R1, rev1: I20).
//
// The Swift (`ios/FeatureExtractor.swift`, `ios/Alignment.swift`) and Kotlin
// (`android/.../FeatureExtractor.kt`, `Alignment.kt`, `GravityFilter.kt`) ports declare these
// under the SAME names with the SAME values. The README's algorithm section refers to them by
// name; changing one here means changing it in both ports and regenerating the golden vectors
// (`npm run vectors:make` equivalent: `node modules/drive-sense/scripts/make-vectors.ts`).
//
// Pure module: no imports, safe under Node strip-types, Deno and Hermes.

/** Standard gravity, m/s² per g. */
export const G_MPS2 = 9.80665;

/** Nominal IMU rate the ports request (40 000 µs on Android, 1/25 s on iOS). */
export const IMU_RATE_HZ = 25;

/** Fewer IMU samples than this in a second → the IMU-absent encoding (R2). */
export const MIN_IMU_SAMPLES = 10;

/** Trailing moving-average length, in samples, applied to horizontal user acceleration. */
export const SMOOTH_SAMPLES = 5;

/** A sample interval longer than this (seconds) is clamped to it for integration and jerk. */
export const IMU_MAX_DT_S = 0.1;

// ——— GNSS ———

/** A fix is valid only with a horizontal accuracy at or under this (metres). */
export const GNSS_MAX_HACC_M = 50;
/** A fix is valid only if it is at most this old (seconds) at the row's timestamp. */
export const GNSS_MAX_AGE_S = 1.5;
/** `hAcc` written when the second has no fix, or the fix's accuracy is unknown (negative). */
export const NO_FIX_HACC_M = 9999;
/** Written for an unknown `speed`, `speedAcc` or `course` (R2). */
export const UNKNOWN = -1;

// ——— Forward-axis alignment (device frame, no magnetometer) ———

/** |ΔvGNSS/Δt| between consecutive valid fixes must reach this (g) for an alignment update. */
export const ALIGN_MIN_G = 0.1;
/** Weight of the new direction in the forward-axis update. */
export const ALIGN_ALPHA = 0.1;
/** Consecutive agreeing updates needed before the frame counts as aligned. */
export const ALIGN_MIN_UPDATES = 5;
/** An update agrees when its direction lies within this angle (rad) of the current forward axis. */
export const ALIGN_TOL_RAD = 0.35;
/**
 * The second's mean horizontal user acceleration must reach this (g) for its direction to be
 * used — below it the direction is noise even when GNSS says the speed changed.
 */
export const ALIGN_MIN_H_G = 0.05;

// ——— Alignment reset (the phone moved relative to the car) ———

/** `orientationDelta` above this in one second resets the alignment. */
export const RESET_ORIENT_RAD = 0.35;
/** The second's gravity direction differing from the recent mean by more than this (rad)… */
export const RESET_GRAVITY_RAD = 0.2;
/** …for this many consecutive seconds resets the alignment. */
export const RESET_GRAVITY_S = 2;
/** Number of past seconds whose mean gravity direction forms the reference for the reset. */
export const GRAVITY_MEAN_S = 10;

// ——— Frame-free phone-state features ———

/** `gravityStability` = 1 − clamp(maxAngle / this, 0, 1). */
export const GRAVITY_STABILITY_RAD = 0.2;
/** Off-gravity-axis angular-rate RMS (rad/s) below which handling reads as zero. */
export const HANDLING_W_FLOOR = 0.15;
/** Span (rad/s) over which the handling score rises from 0 to 1 above the floor. */
export const HANDLING_W_SPAN = 0.6;
/** A second at or above this `gravityStability` counts as steady… */
export const HANDLING_STABLE_GS = 0.95;
/** …and its handling score is multiplied by this. */
export const HANDLING_STABLE_FACTOR = 0.5;

// ——— Android gravity filter (complementary: gyro propagation + accelerometer low-pass) ———

/**
 * Time constant (s) of the accelerometer correction in the gravity filter. Gyro-dominant on
 * purpose: at 0.5 s a 0.45 g brake was absorbed into "gravity" within a second (N1 fix round).
 */
export const GRAVITY_TAU_S = 5;
/**
 * The accelerometer corrects gravity only while its magnitude is within this (g) of 1 g, so
 * dynamic acceleration (a hard brake, a corner) never tilts the estimate; the gyro alone carries it.
 * A horizontal acceleration h moves |a| by √(1 + h²) − 1 ≈ h²/2, so this gate trips at
 * h = √((1 + GATE)² − 1) ≈ 0.2 g — it must stay below HARSH_ACCEL_G (0.28; a test enforces it).
 */
export const GRAVITY_GATE_G = 0.02;
/** A gap between raw samples longer than this (s), or a non-increasing timestamp, re-seeds gravity from the accelerometer. */
export const GRAVITY_RESET_GAP_S = 1;

// ——— Numerics and the self-test ———

/** Vectors shorter than this are treated as zero by `normalize`. */
export const EPS = 1e-9;
/** Largest absolute per-field difference the self-test accepts between a native port and this reference. */
export const SELF_TEST_TOLERANCE = 1e-6;
