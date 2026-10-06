// Contract between the native feature extractor, the detectors and the engine (product spec v3
// "Event detection", plan §2, §6).
import type { DriveEvent, EventType, Tier } from '@scoring';

/**
 * One second of fused sensing at 1 Hz: the GNSS fix, the IMU extremes over that second and the
 * phone-state signals. Accelerations are in g, speeds in m/s, angles in radians unless noted.
 */
export interface FeatureRow {
  /**
   * epoch ms, as an integer: the native module rounds its clock before emitting the row, since
   * the upload contract accepts only whole milliseconds.
   */
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
  /**
   * The fix came from a mock provider (Android `Location.isMock()`, iOS 15+
   * `sourceInformation.isSimulatedBySoftware`). Optional: rows from a native build that predates
   * the key lack it, and absent reads as "not mock" (plan §6; WP7 adds it natively).
   */
  mock?: boolean;
  // ——— DMS motion evidence (design rev4 §2.1.1) ———
  // Optional: rows from an older native build lack them, and every consumer treats an absent field
  // as "no evidence". They never leave the device.
  /** the forward frame was aligned this second (absent: false) */
  frameAligned?: boolean;
  /** the mean of the second's smoothed longitudinal acceleration, g; 0 when unaligned (absent: 0) */
  aLonMean?: number;
  /** the RMS of |user acceleration| over the second, g, frame-free; null with the IMU absent */
  accRms?: number | null;
  /** the second's mean gravity direction, unit vector, device frame; null with the IMU absent */
  gravX?: number | null;
  gravY?: number | null;
  gravZ?: number | null;
}

/** The DMS-only row fields. Never uploaded (nothing is: v3 uploads no rows at all). */
export const MOTION_ROW_FIELDS = ['frameAligned', 'aLonMean', 'accRms', 'gravX', 'gravY', 'gravZ'] as const satisfies readonly (keyof FeatureRow)[];

/** The speed limit the map layer believes applies to a row. */
export interface LimitSample {
  limitMps: number | null;
  source: 'posted' | 'statutory' | 'cached' | 'unknown';
  /** 0..1 */
  matchConfidence: number;
  parallelRoads: boolean;
}

/** A camera focus episode, delivered on the row it ended (the DMS's seam; WP8 owns its detector). */
export interface CameraFocusSample {
  /** seconds the eyes were off the forward zone, or the length of the drowsiness episode */
  glanceS: number;
  kind: 'glance' | 'drowsiness';
  /** camera confidence, 0..1 */
  q: number;
  correctedWithinGrace?: boolean;
}

export interface DetectorContext {
  /** epoch ms the drive started: no events in its first `NO_EVENTS_FIRST_S` (spec). */
  tripStartedAt: number;
  /** A hands-free call is active (where the native signal exists): phone events are suppressed. */
  callActive: boolean;
  /**
   * The row's `locked` / `screenOn` can be believed (drive-sense `lockSignal !== 'unreliable'`): an
   * iPhone without a passcode never reports locked, so an unlocked screen is no unlock evidence there.
   */
  lockReliable: boolean;
  /** The lock signal arrives late (iOS with a passcode, ~10 s): unlock evidence is held back. */
  lockLagged: boolean;
  cameraFocus?: CameraFocusSample | null;
}

/** What the detector measured; shown on the summary and sent with the event (plan §3). */
export interface EventMeasured {
  speedMph?: number;
  limitMph?: number;
  peakG?: number;
  mounted?: boolean;
}

/** A scorable v3 event as a detector closes it. Coordinates are added at finalize from the track. */
export interface DetectedEvent extends DriveEvent {
  measured: EventMeasured;
}

export interface Detector {
  /** Feed one row; returns the events that closed on it. */
  push(row: FeatureRow, limit: LimitSample, ctx: DetectorContext): DetectedEvent[];
  /** Close whatever is still open at trip end. */
  flush(): DetectedEvent[];
}

/** An episode in progress, for the HUD's glow and the alert layer. */
export interface OpenEpisode {
  id: string;
  type: EventType;
  /** The tier so far (speeding: the current row's; phone: severe). */
  tier: Tier;
  startedAt: number;
  /** Long enough to count as an incident (speeding 5 s / 3 s severe; phone 3 s). */
  confirmed: boolean;
}

/** Every detector behind one `push`/`flush`, plus what the engine reads per row. */
export interface DetectorSuite extends Detector {
  /** The speeding episode in progress on the latest row, if any. */
  openSpeeding(): OpenEpisode | null;
  /** The phone episode in progress on the latest row, if any. */
  openPhone(): OpenEpisode | null;
  /** A speeding or phone episode is active on the latest row: its distance is not safe miles. */
  unsafe(): boolean;
}
