// The engine's own types (plan Task 5). The engine never sees the wire: the host converts each
// decoded frame record into an EngineFrame and each 1 Hz FeatureRow into a VehicleContext, so the
// engine stays pure and portable (the purity test). All times are on the frame clock `tMs` (§M1).

/** Degrees. Camera frame: yaw + toward image right, pitch + up (plan §M1). */
export interface AnglePair {
  yaw: number;
  pitch: number;
}

/** Head pose in the camera frame, degrees; roll + tilts the head's up vector toward image right. */
export interface HeadAngles extends AnglePair {
  roll: number;
}

/** A unit direction in the camera frame: x image right, y up, z along the optical axis. */
export type Direction = readonly [number, number, number];

/** Left-hand drive ('left': the driver sits on the left) or right-hand drive. */
export type DriverSide = 'left' | 'right';

export type Sensitivity = 'low' | 'normal' | 'high';

export type GazeSource = 'geometric' | 'net';

export type Rotation = 0 | 90 | 180 | 270;

/** One eye's wire features; null on the frame when that eye is clipped (EYE_CLIPPED_*). */
export interface EyeFeatures {
  ear: number;
  /** corner distance, upright pixels */
  widthPx: number;
  /** mean eye-ROI luma ÷ face luma */
  luma: number;
  irisContrast: number;
  /** share of saturated pixels in the eye ROI */
  sat: number;
  /** iris offset in eye widths; + image right */
  ox: number;
  /** iris offset in eye widths; + image up */
  oy: number;
  irisIn: boolean;
}

export interface FaceBox {
  /** normalised upright-frame centre and size */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** The engine's copy of the fields of one frame record it uses (plan Task 5). */
export interface EngineFrame {
  /** frame clock, ms (double) */
  tMs: number;
  face: boolean;
  /** null when there is no face */
  box: FaceBox | null;
  /** interocular distance ÷ upright width; null when there is no face */
  iod: number | null;
  /** null when there is no face or POSE_MISSING */
  head: HeadAngles | null;
  /** the gaze net's angles on frames where it ran (NET_RAN); null otherwise */
  net: AnglePair | null;
  eyeR: EyeFeatures | null;
  eyeL: EyeFeatures | null;
  /** null when there is no face */
  faceLuma: number | null;
  blur: number | null;
  /** null when there is no face or MOUTH_CLIPPED */
  mouth: { mar: number; widthIod: number } | null;
  frameLuma: number;
  rotationDeg: Rotation;
  latTotalMs: number;
}

/**
 * The vehicle context the engine applies at the latest `tMs` (plan §M1, rev1 I5/I6). The host builds it
 * from the 1 Hz FeatureRow (Task 8's `contextFromRow`).
 */
export interface VehicleContext {
  /** the frame-clock time it applies from */
  tMs: number;
  /** null: unknown (speed < 0, no GNSS fix, or a stale row) */
  speedKmh: number | null;
  /** the unsigned 1 s gyro peak, °/s; null when the IMU is absent */
  yawRateDegS: number | null;
  /** the signed GNSS course rate, °/s (+ right); null when it cannot be computed */
  courseRateDegS: number | null;
  /** from the course rate; 0 when unknown or below the turn threshold */
  turnSign: -1 | 0 | 1;
  /** the straight-driving flag (§M3); null when GNSS is invalid */
  straight: boolean | null;
  /** phone handling (handlingScore ≥ 0.6) */
  handling: boolean;
  imuPresent: boolean;
  /** the drive engine's own "not still without a fix" (rev2 R1-m1) */
  imuMoving: boolean;
  /** local time of day, minutes since midnight; null when unknown */
  localMinutes: number | null;
  tripElapsedS: number;
}
