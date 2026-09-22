// Input and output shapes of the feature-extraction reference.
//
// `ExtractedRow` is structurally identical to M1's `FeatureRow` (`src/core/engine/types.ts`);
// `src/types.ts` asserts the two are mutually assignable, so a field added to one and not the
// other fails `tsc`. It is redeclared here so `src/extract/**` imports nothing outside itself
// and stays runnable under Node strip-types, Deno and the native self-test tooling.
import type { Vec3 } from './vec';

export type { Vec3 };

/**
 * One IMU sample after normalisation (device frame; x right, y toward the top of the screen,
 * z out of the screen — identical on iOS and Android).
 */
export interface ImuSample {
  /** epoch ms (may be fractional) */
  t: number;
  /** user acceleration, g, device frame, in the same sign convention as `g` (a = g + ua) */
  ua: Vec3;
  /** gravity, g, pointing toward the earth, device frame (face-up on a table: ≈ [0, 0, −1]) */
  g: Vec3;
  /** angular rate, rad/s, device frame, right-handed (counter-clockwise positive) */
  w: Vec3;
}

/**
 * One raw Android sample in the reference sign convention: `a` is the accelerometer INCLUDING
 * gravity, in g, with CoreMotion's sign — face-up on a table reads ≈ [0, 0, −1]. Android's
 * `TYPE_ACCELEROMETER` (m/s², face-up ≈ [0, 0, +9.81]) converts as `a = −values / G_MPS2`.
 */
export interface RawImuSample {
  /** epoch ms (may be fractional) */
  t: number;
  a: Vec3;
  /** `TYPE_GYROSCOPE`, rad/s, device frame */
  w: Vec3;
}

/** The complementary filter's carry-over between batches. */
export interface GravityState {
  /** current gravity estimate, g, toward the earth; null before the first sample */
  g: Vec3 | null;
  /** epoch ms of the last sample consumed; null before the first sample */
  t: number | null;
}

/** One GNSS fix as the platform delivered it (unknowns as negative numbers). */
export interface FixSample {
  /** epoch ms of the fix */
  t: number;
  lat: number;
  lng: number;
  /** metres; negative = unknown */
  hAcc: number;
  /** m/s; negative = unknown */
  speed: number;
  /** m/s; negative = unknown */
  speedAcc: number;
  /** degrees clockwise from true north; negative = unknown */
  course: number;
  /** metres */
  alt: number;
}

export interface PhoneSample {
  locked: boolean;
  screenOn: boolean;
  appForeground: boolean;
}

/** Structurally identical to M1's `FeatureRow`. */
export interface ExtractedRow {
  ts: number;
  lat: number;
  lng: number;
  hAcc: number;
  speed: number;
  speedAcc: number;
  course: number;
  alt: number;
  gnssValid: boolean;
  aLonMax: number;
  aLonMin: number;
  aLatMax: number;
  aLatMin: number;
  yawRateMax: number;
  jerkMax: number;
  gravityStability: number;
  orientationDelta: number;
  handlingScore: number;
  locked: boolean;
  screenOn: boolean;
  appForeground: boolean;
}

/** Forward-axis alignment and its reset detector. */
export interface AlignmentState {
  /** learned forward axis (unit, device frame, horizontal), or null before the first update */
  f: Vec3 | null;
  /** consecutive updates that agreed with `f` within ALIGN_TOL_RAD */
  agree: number;
  /** true once `agree` reached ALIGN_MIN_UPDATES; cleared only by a reset */
  aligned: boolean;
  /** the last ≤ GRAVITY_MEAN_S per-second mean gravity directions (unit vectors), oldest first */
  gravityRing: Vec3[];
  /** consecutive seconds the gravity direction deviated from the ring's mean by > RESET_GRAVITY_RAD */
  gravityDevS: number;
}

export interface ExtractState {
  /** position of the most recent fix of any quality, for the no-fix rows */
  lastFix: { lat: number; lng: number; alt: number } | null;
  /** the previous second's fix when it was valid with a known speed; null otherwise */
  prevValidFix: { t: number; speed: number } | null;
  /** epoch ms of the last IMU sample consumed; null before any */
  lastImuT: number | null;
  /** the last ≤ SMOOTH_SAMPLES − 1 horizontal user-acceleration vectors, oldest first */
  hTail: Vec3[];
  /** the last smoothed longitudinal value and its time, for jerk across the second boundary */
  prevLon: { t: number; v: number } | null;
  alignment: AlignmentState;
}
