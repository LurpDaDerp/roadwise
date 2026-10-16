// Contract between the native feature extractor, the detectors and the engine (product spec v3
// "Event detection", plan §2, §6).
import type { DriveEvent, EventType, Tier } from '@scoring';

import type { SwitchSignal } from '../detectors/phoneSwitch';

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
  /**
   * RoadWise is in front (Android: a started RoadWise activity, not sharing a phone-sized screen in
   * split screen; iOS: the app is not in the background). Its absence while the phone is unlocked
   * with its screen on is a screen switch (`detectors/phoneSwitch.ts`).
   */
  appForeground: boolean;
  /**
   * The fix came from a mock provider (Android `Location.isMock()`, iOS 15+
   * `sourceInformation.isSimulatedBySoftware`). Optional: rows from a native build that predates
   * the key lack it, and absent reads as "not mock" (plan §6; WP7 adds it natively).
   */
  mock?: boolean;
  /**
   * A call during the row (bridge-only, like `mock`): `ring` while one rings or dials, `live` while
   * one is connected; absent with none. A call's own screen is not a screen switch.
   */
  call?: 'ring' | 'live';
  /**
   * Stamped by the drive host before the row reaches the engine, never by native (`parseRow`
   * strips it): `nav` while the navigation button's exemption runs, `restart` while the home
   * screen a mid-drive process restart left behind is excused. Exempt rows are never a screen
   * switch; motion use, speeding and harsh events read them as usual. Stored with the row, so a
   * rebuild agrees.
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
   * epoch ms before which no event starts: `NO_EVENTS_FIRST_S` after the Start tap for a drive
   * that starts stopped, the first trusted reading over 5 mph for one started while moving, the
   * start itself for a restart (`TripSession.warmup`).
   */
  warmupEndsAt: number;
  /**
   * A call is active (the iOS CallKit observer, live only): phone motion is not counted. The rows'
   * own `call` key does the same on iPhone, live and rebuilt alike (`phoneUse.ts`).
   */
  callActive: boolean;
  /** How this drive tells a screen switch from a lock (`phoneSwitch.ts`), fixed at the Start tap. */
  switchSignal: SwitchSignal;
  /** iOS: the lock-report delay measured before the drive (ms), or null; Android null. */
  lockDelayMs: number | null;
  /** The phone that recorded the drive. */
  platform: 'ios' | 'android';
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
  /** Long enough to count as an incident (speeding 5 s / 3 s severe; phone 3 s, a switch 3 s / 26 s). */
  confirmed: boolean;
  /** Phone: the latest row of use so far (motion or a counting switch). Speeding never sets it. */
  lastUseAt?: number;
  /**
   * Phone: `switching` while a counted screen switch goes on, `hold` while an iPhone departure
   * waits out its 26 s inside an open pickup, else null. Speeding never sets it.
   */
  phase?: 'switching' | 'hold' | null;
}

/** Every detector behind one `push`/`flush`, plus what the engine reads per row. */
export interface DetectorSuite extends Detector {
  /** The speeding episode in progress on the latest row, if any. */
  openSpeeding(): OpenEpisode | null;
  /** The phone episode in progress on the latest row, if any. */
  openPhone(): OpenEpisode | null;
  /** A speeding or phone episode is active on the latest row: its distance is not safe miles. */
  unsafe(): boolean;
  /**
   * iPhone: the latest in-drive lock proof (a lock reported within 15 s of RoadWise leaving the
   * screen), with its delay `row.ts − left − one row`, ms; null before any.
   */
  lockProof(): { delayMs: number } | null;
}
