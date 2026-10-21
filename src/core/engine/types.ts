// Contract between the native feature extractor, the detectors and the engine (product spec
// "Event detection"; modes plan §3.9; phone plan P1).
import type { DriveEvent, EventType, Tier } from '@scoring';

/**
 * One second of fused sensing at 1 Hz: the GNSS fix, the IMU extremes over that second and the
 * phone-state signals. Accelerations are in g, speeds in m/s, angles in radians unless noted.
 *
 * The field list is the native row contract (frozen on Android), so every field stays; nothing in
 * JS reads `locked`, `screenOn`, `appForeground` or `exempt` (phone use is motion only); the phone
 * detector reads `call` on iPhone.
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
  /** Row contract only; read nowhere in JS. */
  locked: boolean;
  /** Row contract only; read nowhere in JS. */
  screenOn: boolean;
  /** RoadWise is in front, as native saw it. Row contract only; read nowhere in JS. */
  appForeground: boolean;
  /**
   * The fix came from a mock provider (Android `Location.isMock()`, iOS 15+
   * `sourceInformation.isSimulatedBySoftware`). Optional: rows from a native build that predates
   * the key lack it, and absent reads as "not mock".
   */
  mock?: boolean;
  /**
   * A call during the row (bridge-only, like `mock`): `ring` or `live`; absent with none. Stored with
   * the row. On iPhone a row with a call is never phone use (`detectors/phoneUse.ts`): iOS cannot
   * tell hands-free from handheld. Android motion is never suppressed by a call.
   */
  call?: 'ring' | 'live';
  /**
   * An exemption stamp an older build's host wrote on stored rows (`nav`, `restart`). Never written
   * now; kept optional so stored samples and traces still parse.
   */
  exempt?: 'nav' | 'restart';
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
  /**
   * epoch ms before which no event starts: `NO_EVENTS_FIRST_S` after the start for a drive that
   * starts stopped, the first trusted reading over 5 mph for one started while moving, the start
   * itself for a continuation (`TripSession.warmup`).
   */
  warmupEndsAt: number;
  /** The phone that recorded the drive: on iPhone a row with a call is never phone use. */
  platform: 'ios' | 'android';
}

/** What the detector measured; shown on the summary and sent with the event. */
export interface EventMeasured {
  speedMph?: number;
  limitMph?: number;
  peakG?: number;
  /** speeding: mph past the speeding line summed over the over rows after the grace (1 dp); the Speed weight reads it. */
  overMphS?: number;
  /** phone_pickup: the highest trusted GPS speed from the pickup's start through its last use row, mph (1 dp). */
  maxSpeedMph?: number;
  /** `dashcam` on (and only on) a DashPal event (`eyes_off`, `drowsy`); the phone's own detectors never set it. */
  source?: 'dashcam';
}

/** A scorable event as a detector closes it. Coordinates are added at finalize from the track. */
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
  /** The tier so far (speeding: the current row's). */
  tier: Tier;
  startedAt: number;
  /** Long enough to count as an incident (speeding: past the 5-s grace). */
  confirmed: boolean;
}

/** The three hard-movement kinds. */
export type HarshKind = 'hard_brake' | 'hard_accel' | 'hard_corner';

/** A hard brake, start or turn the harsh detector has just confirmed: alert it now (its tier so far). */
export interface HarshAlert {
  id: string;
  type: HarshKind;
  tier: Tier;
}

/**
 * A phone pickup alert the phone detector raised on the latest row: the pickup confirmed (the first
 * alert, its tier so far), or `repeat` as its time in hand reached the next mark.
 */
export interface PhoneAlert {
  /** The pickup's id (its event's, once it closes). */
  id: string;
  tier: Tier;
  repeat: boolean;
}

/** The speeding episode in progress (its end window included), as the engine's alerts read it. */
export interface SpeedingEpisode {
  id: string;
  /** epoch ms of its first over row. */
  startedAt: number;
  /** Over rows so far (`durationS` if it closed now). */
  overRows: number;
  /** mph past the line summed over the over rows after the grace, unrounded (0 within the grace). */
  overMphS: number;
  /** Past the grace: it is an event. */
  confirmed: boolean;
  /** The current row is over the line. */
  over: boolean;
}

/** What the speeding detector read on its latest row, when it could use the row. */
export interface SpeedingReading {
  /** The row's speed over the posted limit it is judged on (1 = at the limit). */
  ratio: number;
  /** mph past the speeding line (L + T): over the line when above 0. */
  overMph: number;
}

/** Every detector behind one `push`/`flush`, plus what the engine reads per row. */
export interface DetectorSuite extends Detector {
  /** The speeding episode in progress on the latest row, if any. */
  openSpeeding(): OpenEpisode | null;
  /**
   * The speeding detector's reading of the latest row: null when it could not use it (no posted
   * limit it acts on, an unknown or untrusted speed, a poor fix, the warm-up).
   */
  speedingNow(): SpeedingReading | null;
  /** The speeding episode in progress, its end window included (whatever the current row), or null. */
  speedingEpisode(): SpeedingEpisode | null;
  /** The hard brakes, starts and turns first confirmed on the latest row (each told once). */
  harshAlerts(): HarshAlert[];
  /** The phone pickup alerts the latest row raised (at most one; each told once). */
  phoneAlerts(): PhoneAlert[];
  /** A speeding episode past its grace is active on the latest row: its distance is not safe miles. */
  unsafe(): boolean;
}
