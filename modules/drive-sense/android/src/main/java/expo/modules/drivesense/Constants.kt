package expo.modules.drivesense

// Every tunable number of the feature-extraction reference, under the SAME names and values as
// `src/extract/constants.ts` and `src/extract/timebase.ts` (README §7 "Constants"). The JS text test
// `__tests__/native-android.test.ts` compares each one with the reference; change them only with
// the reference and a regeneration of the golden vectors.

/** Standard gravity, m/s² per g. */
const val G_MPS2 = 9.80665

/** Nominal IMU rate requested (40 000 µs sampling period). */
const val IMU_RATE_HZ = 25

/** Fewer IMU samples than this in a second → the IMU-absent encoding (R2). */
const val MIN_IMU_SAMPLES = 10

/** Trailing moving-average length, in samples. */
const val SMOOTH_SAMPLES = 5

/** A sample interval longer than this (s) is clamped to it. */
const val IMU_MAX_DT_S = 0.1

// ——— GNSS ———
const val GNSS_MAX_HACC_M = 50
const val GNSS_MAX_AGE_S = 1.5
const val NO_FIX_HACC_M = 9999
const val UNKNOWN = -1

// ——— Forward-axis alignment ———
const val ALIGN_MIN_G = 0.1
const val ALIGN_ALPHA = 0.1
const val ALIGN_MIN_UPDATES = 5
const val ALIGN_TOL_RAD = 0.35
const val ALIGN_MIN_H_G = 0.05

// ——— Alignment reset ———
const val RESET_ORIENT_RAD = 0.35
const val RESET_GRAVITY_RAD = 0.2
const val RESET_GRAVITY_S = 2
const val GRAVITY_MEAN_S = 10

// ——— Frame-free features ———
const val GRAVITY_STABILITY_RAD = 0.2
const val HANDLING_W_FLOOR = 0.15
const val HANDLING_W_SPAN = 0.6
const val HANDLING_STABLE_GS = 0.95
const val HANDLING_STABLE_FACTOR = 0.5

// ——— Android gravity filter ———
const val GRAVITY_TAU_S = 5
const val GRAVITY_GATE_G = 0.02
/** The gate reads the mean |a| over this many samples (200 ms at 25 Hz), restarted on a re-seed. */
const val GRAVITY_GATE_SAMPLES = 5
const val GRAVITY_RESET_GAP_S = 1

// ——— Numerics and the self-test ———
const val EPS = 1e-9
const val SELF_TEST_TOLERANCE = 1e-6

// ——— Time base and windows (`timebase.ts`) ———
const val TIMEBASE_MAX_SKEW_MS = 2000
const val MAX_ROW_GAP_MS = 2000
const val FIRST_WINDOW_MS = 1000
