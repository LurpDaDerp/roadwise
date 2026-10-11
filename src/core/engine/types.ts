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
}

/** The speed limit the map layer believes applies to a row. */
export interface LimitSample {
  limitMps: number | null;
  source: 'posted' | 'statutory' | 'cached' | 'unknown';
  /** 0..1 */
  matchConfidence: number;
  parallelRoads: boolean;
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
}

/** What the detector measured; shown on the summary and sent with the event (plan §3). */
export interface EventMeasured {
  speedMph?: number;
  limitMph?: number;
  peakG?: number;
  mounted?: boolean;
  /** `dashcam` on (and only on) a DashPal event (`eyes_off`, `drowsy`); the phone's own detectors never set it. */
  source?: 'dashcam';
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
