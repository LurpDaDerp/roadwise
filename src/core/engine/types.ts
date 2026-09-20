// Contract between the feature extractor, the detectors and the scorer (spec §9.3, §9.5, §9.7).
import type { FocusKind, ScorableEvent } from '@scoring';

/**
 * One second of fused sensing at 1 Hz: the GNSS fix, the IMU extremes over that second and the
 * phone-state signals. Accelerations are in g, speeds in m/s, angles in radians unless noted.
 */
export interface FeatureRow {
  /** epoch ms */
  ts: number;
  lat: number;
  lng: number;
  /** horizontal accuracy, metres */
  hAcc: number;
  /** m/s; -1 when unknown */
  speed: number;
  /** speed accuracy, m/s */
  speedAcc: number;
  /** degrees clockwise from true north */
  course: number;
  alt: number;
  gnssValid: boolean;
  /** longitudinal extremes over the second, g (positive = accelerating) */
  aLonMax: number;
  aLonMin: number;
  /** lateral extremes over the second, g */
  aLatMax: number;
  aLatMin: number;
  yawRateMax: number;
  jerkMax: number;
  /** 0..1 — how steady the gravity vector stayed over the second */
  gravityStability: number;
  /** rad — how far the phone's orientation moved over the second */
  orientationDelta: number;
  /** 0..1 — how much the second looked like the phone being handled */
  handlingScore: number;
  locked: boolean;
  screenOn: boolean;
  appForeground: boolean;
}

/** The speed limit the map layer believes applies to a row (§9.5 speed-limit source). */
export interface LimitSample {
  limitMps: number | null;
  source: 'posted' | 'statutory' | 'cached' | 'unknown';
  /** 0..1 */
  matchConfidence: number;
  parallelRoads: boolean;
}

export type DriveMode = 'mounted' | 'pocket' | 'auto';

/** A camera focus episode, delivered on the row it ended (§9.3 focus & alertness). */
export interface CameraFocusSample {
  /** seconds the eyes were off the forward zone, or the length of the drowsiness episode */
  glanceS: number;
  kind: FocusKind;
  /** camera confidence, 0..1 (§9.5) */
  q: number;
  /** the glance ended inside `GLANCE_GRACE_S` of an alert, as judged by the camera pipeline */
  correctedWithinGrace?: boolean;
}

export interface DetectorContext {
  mode: DriveMode;
  night: boolean;
  precipitation: boolean;
  cameraFocus?: CameraFocusSample | null;
}

export type EventSource = 'gnss' | 'imu' | 'both' | 'os' | 'camera';

/** A scorable event plus what the alert layer needs to know about it. */
export interface DetectedEvent extends ScorableEvent {
  alertable: boolean;
  source: EventSource;
  /**
   * Ids of the events `mergeEvents` folded into this one, in absorption order, so an alert or a
   * dispute that referenced them can still be traced. Absent when nothing was absorbed.
   */
  absorbedIds?: string[];
}

export interface Detector {
  /** Feed one row; returns the events that closed on it. */
  push(row: FeatureRow, limit: LimitSample, ctx: DetectorContext): DetectedEvent[];
  /** Close whatever is still open at trip end. */
  flush(): DetectedEvent[];
}

/** Every detector behind one `push`/`flush`, plus the alert layer's hooks (`createDetectors`). */
export interface DetectorSuite extends Detector {
  /** Record that the driver was alerted about the open episode `id` at `ts` (epoch ms). */
  markAlerted(id: string, ts: number): void;
  /** Id of the speeding episode that is currently open and long enough to be an event, if any. */
  openSpeedingEpisodeId(): string | null;
}
