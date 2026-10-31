/**
 * Problem spots: the shapes the detection, the data layer, the drive host and the screens share
 * (spots.md §2.3, §7.2). A spot is a place where the same thing keeps happening in the same
 * direction of travel; it is derived on the phone and never leaves it.
 */
import type { LatLng } from '@/lib/geo';

/** A spot's kind is the event type it is made of. */
export type SpotKind = 'speeding' | 'hard_brake' | 'hard_corner' | 'hard_accel';

/** A scored drive as the detection reads it. */
export interface SpotDrive {
  clientTripId: string;
  /** Epoch ms. */
  startedAt: number;
  /** The route's runs as the driver's own views draw it (the whole route where the phone holds it), travel order, each at least 2 points. */
  runs: readonly (readonly LatLng[])[];
}

/** A located event that can make a spot. */
export interface SpotEvent {
  id: string;
  clientTripId: string;
  type: SpotKind;
  /** Epoch ms. */
  startedAt: number;
  durationS: number;
  lat: number;
  lng: number;
  /** `measured.speedMph`. */
  speedMph: number | null;
  /** `measured.limitMph` (speeding only). */
  limitMph: number | null;
}

/** One spot as the detection finds it. */
export interface DetectedSpot {
  /** `${kind}:${anchorEventId}`: stable while its oldest event stays in the window. */
  id: string;
  kind: SpotKind;
  state: 'active' | 'cleared';
  /** The nudge target and the pin's tip: a speeding spot's start, else its centre on the road. */
  pin: LatLng;
  /** Travel direction at the pin, degrees clockwise from true north. */
  headingDeg: number;
  /** The coloured road, at least 2 points. */
  segment: LatLng[];
  /** Speeding only: the most common posted limit of its events (a tie goes to the lower). */
  limitMph: number | null;
  /** Hits (drives with the event here) since the spot's (re)start. */
  hits: number;
  /** Drives through it, its way, since the spot's (re)start. */
  passes: number;
  /** Hits among the last `RECENT_PASSES` passes. */
  recentHits: number;
  recentPasses: number;
  /** The recency-weighted rate after the last pass, 3 dp. */
  rate: number;
  /** Clean passes since the last hit. */
  cleanStreak: number;
  /** The clean run that clears it (K). */
  cleanNeeded: number;
  /** When the event last happened here (the newest hit's event, epoch ms). */
  lastHitAt: number;
  /** The newest hit's drive (the sheet's "Open drive"). */
  lastHitTrip: string;
  /** When a drive last passed (its start, epoch ms). */
  lastPassAt: number;
  /** A cleared spot's clearing pass (its drive's start); null while active. */
  clearedAt: number | null;
  /** 1..5 for an active spot, 0 for a cleared one. */
  rank: number;
}

/** An active spot as the driving screen watches for it. */
export interface WatchSpot {
  id: string;
  kind: SpotKind;
  lat: number;
  lng: number;
  headingDeg: number;
}

/** One row as the watcher reads it. */
export interface WatchInput {
  /** The row clock, epoch ms. */
  ts: number;
  lat: number;
  lng: number;
  hAcc: number;
  gnssValid: boolean;
  /** The row's GPS speed in m/s, −1 when unknown. */
  speedMps: number;
  /** `row.course` when ≥ 0, else the engine's held course; null when neither is known. */
  courseDeg: number | null;
  /** A confirmed drive is recording (never a "waiting" session). */
  recording: boolean;
  /** RoadWise is in front (AppState `active`). */
  foreground: boolean;
  /** Another alert is showing or just showed, or a DashPal alert is on. */
  busy: boolean;
  /** The current row is over the speeding line. */
  speedingOver: boolean;
}

/**
 * The driving screen's spot nudge (`DriveLive.spotNudge`): shown once per `key`
 * (`${spotId}@${at}`), for `SPOT_NUDGE_MS` on the row clock from `at`.
 */
export interface SpotNudge {
  key: string;
  spotId: string;
  kind: SpotKind;
  /** The row's ts. */
  at: number;
}

export interface SpotWatcher {
  /** Feed one row; a nudge to show now, or null. */
  push(input: WatchInput): SpotNudge | null;
}
