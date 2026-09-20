// The trip engine's contract (design §3.1, spec §8.4–8.9, Appendix A).
//
// Everything the engine knows about the outside world comes in through `EngineDeps` and
// `EngineEvent`; everything it decides goes out through the `EngineDeps` callbacks and
// `EngineSnapshot`. Time is only ever the `ts` on an event or a row.
import type { AlertDecision, Arbiter } from '../alerts/types';
import type { TripDetectors } from '../detectors';
import type { DetectedEvent, DetectorContext, DriveMode, FeatureRow, LimitSample } from './types';

export type EngineStatus = 'off' | 'armed' | 'candidate' | 'recording' | 'ending' | 'finalizing';

export type TripRole = 'driver' | 'passenger';

/** How the trip was confirmed: the user tapped Start (§8.4) or the auto-detect window closed (§8.5). */
export type StartSource = 'manual' | 'auto';

export interface Fix {
  lat: number;
  lng: number;
  /** epoch ms */
  ts: number;
}

/**
 * A stretch the trip was in `ending` and then resumed (gap-merge, §19.1 "drive-through, fuel
 * stop"). `fromTs` is where driving stopped — the start of an idle stretch that was still open,
 * else one row-length after the last recorded row — and `toTs` the moment recording resumed, so
 * `toTs - fromTs` is exactly the time that was not driving.
 */
export interface TripGap {
  fromTs: number;
  toTs: number;
}

/**
 * One trip as the engine accumulates it. Mutable while open; the finalizer receives a frozen
 * copy once. `rows` is only the in-memory ring of the last `RING_S` seconds — the full 1 Hz
 * record lives wherever `onCheckpoint` put it.
 */
export interface TripSession {
  clientTripId: string;
  mode: DriveMode;
  role: TripRole;
  startSource: StartSource;
  /** epoch ms — the first row of the trip, or the OS motion-history backfill (§8.5 step 4). */
  startedAt: number;
  /** `startedAt` came from the motion history rather than a fix (marked in data quality, §8.5). */
  startApproximate: boolean;
  /**
   * epoch ms — where driving stopped: the start of an idle stretch that was still open when the
   * trip closed (a stationary auto-end trims its five idle minutes), else one row-length after the
   * last row, or the closing event's `ts` for a trip with no rows. Rows may run past it. Null
   * while the trip is open.
   */
  endedAt: number | null;
  lastRowTs: number | null;
  /** Rows appended over the whole trip, ring or not. */
  rowsCount: number;
  validGnssRows: number;
  /** Rows whose speed limit was known, for `limit_coverage_pct`. */
  limitKnownRows: number;
  /** The last `RING_S` seconds of rows, oldest first. */
  rows: FeatureRow[];
  events: DetectedEvent[];
  /** Every alert delivered this trip, in order. */
  alerts: AlertDecision[];
  /** Haversine over consecutive valid fixes, metres. */
  distanceM: number;
  /** 0..100 */
  validGnssPct: number;
  /** Highest 10 s rolling mean of the GNSS speed, m/s (§9.4 implausible-speed check). */
  maxSustainedSpeedMps: number;
  /** Seconds of trip time net of `gaps`. */
  durationS: number;
  gaps: TripGap[];
  /**
   * `ts` of the last row covered by each completed checkpoint, in order. Rows after the last
   * entry are not yet durable. The session handed to `onCheckpoint` lists the checkpoints
   * completed *before* that call, so the rows with `ts > checkpoints.at(-1)` are what the call
   * must persist — they are all inside `rows`, since the ring is longer than the cadence. Besides
   * the cadence, the tail is checkpointed as the trip goes to `ending` and again just before
   * `onFinalize`, so no row is left for the ring to evict.
   */
  checkpoints: number[];
  firstFix: Fix | null;
  lastFix: Fix | null;
}

export interface EngineSnapshot {
  status: EngineStatus;
  mode: DriveMode;
  role: TripRole;
  clientTripId: string | null;
  startedAt: number | null;
  /** epoch ms of the last row seen in `candidate`, `recording` or `ending`. */
  lastRowTs: number | null;
  /** m/s; 0 when unknown. */
  speedMps: number;
  limit: LimitSample;
  distanceM: number;
  /** epoch ms of the first row of the current run of speed < 0.5 m/s (C8 auto-end). */
  stationarySinceTs: number | null;
  /** recording, driver role, speed > `LOCKOUT_SPEED_MPS` (SR2, §3.4). */
  lockedOut: boolean;
  /** recording and at 0 m/s for `STOPPED_PANEL_S` (C6); cleared once moving again. */
  stoppedPanel: boolean;
}

export interface EngineDeps {
  /** epoch ms. Reserved for the host; the reducer itself is driven by event and row `ts`. */
  now(): number;
  /** A fresh `clientTripId`. */
  newId(): string;
  limits: {
    /** The cached limit for a fix, or null when nothing is cached (treated as unknown). */
    lookup(lat: number, lng: number, course: number): LimitSample | null;
    /** Warm the cache along the heading; called once per `PREFETCH_EVERY_M` travelled (§3.5). */
    prefetch(lat: number, lng: number, course: number): void;
  };
  /** A fresh detector suite for each trip, made when the trip is confirmed. */
  createDetectors(): TripDetectors;
  /** A fresh arbiter for each trip; the host closes over its `ArbiterState` (trip index, carried mute). */
  createArbiter(): Arbiter;
  onAlert(decision: AlertDecision): void;
  /** Every `CHECKPOINT_S` rows. Owns persistence; a rejection leaves the checkpoint unrecorded. */
  onCheckpoint(session: Readonly<TripSession>): Promise<void>;
  /** Once per trip with the closed session; the finalizer scores and stores it. */
  onFinalize(session: Readonly<TripSession>): Promise<void>;
  /**
   * Where a failure that must not stop the engine is reported: a finalizer or detector flush that
   * threw (after the engine has moved on and any follow-on trip has started) and a subscriber
   * that threw. Without it a finalize failure rejects the dispatch — still after the state change
   * — and a subscriber's error is dropped.
   */
  onError?(err: unknown): void;
  /** The per-row detector context minus `mode`, which the engine knows. */
  ctx(): Omit<DetectorContext, 'mode'>;
}

export type WakeReason = 'significantChange' | 'activityTransition' | 'boot' | 'geofence';

export type EngineEvent =
  | { type: 'arm' }
  | { type: 'disarm' }
  | {
      type: 'wake';
      reason: WakeReason;
      ts: number;
      /** epoch ms the OS motion history says the drive began, to backfill `startedAt`. */
      candidateStartTs?: number;
    }
  | { type: 'activity'; automotive: boolean; walking: boolean; ts: number; candidateStartTs?: number }
  | { type: 'manualStart'; mode: DriveMode; passenger: boolean; ts: number }
  | { type: 'row'; row: FeatureRow }
  | { type: 'setPassenger'; passenger: boolean; ts: number }
  | { type: 'end'; ts: number }
  | { type: 'tick'; ts: number };

export interface Engine {
  /** Serialised: a dispatch never starts before the previous one has settled. */
  dispatch(event: EngineEvent): Promise<void>;
  /** A frozen copy of the current state. */
  snapshot(): EngineSnapshot;
  /** Called with a fresh snapshot after every state change; returns the unsubscribe. */
  subscribe(fn: (snapshot: EngineSnapshot) => void): () => void;
}
