// The drive engine's contract (product spec v3 "Starting and ending a drive", plan §5, §10).
//
// Everything the engine knows about the outside world comes in through `EngineDeps` and
// `EngineEvent`; everything it decides goes out through the `EngineDeps` callbacks and
// `EngineSnapshot`. Time is only ever the `ts` on an event or a row.
import type { MotionActivity } from '@drive-sense';
import type { EventType, Tier } from '@scoring';

import type { DetectedEvent, DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

/** idle → recording → finalizing → idle. Nothing starts a drive but `start`. */
export type EngineStatus = 'idle' | 'recording' | 'finalizing';

/** Why the drive closed. Local only; never uploaded. `limit`: it reached `MAX_DRIVE_MS`. */
export type EndCause = 'manual' | 'stopped' | 'walking' | 'orphan' | 'limit';

export interface Fix {
  lat: number;
  lng: number;
  /** epoch ms */
  ts: number;
}

/** One valid fix of the drive, kept for the polyline and the events' coordinates. */
export interface TrackPoint extends Fix {
  hAcc: number;
}

/**
 * When the drive's events start counting (spec "Rules against false positives"). Replaced, never
 * mutated (`noteWarmup`).
 */
export interface Warmup {
  /** The drive started within `MERGE_GAP_S` of the end of the phone's previous drive: no warm-up. */
  continues: boolean;
  /** The first trusted speed reading has been seen, or the 30 s are over: `endsAt` is final. */
  decided: boolean;
  /** epoch ms; rows before it start no event. */
  endsAt: number;
}

/**
 * The session as it stood right after the drive's latest movement row (`session.ts` "Movement"):
 * what a drive closed at its last movement keeps. Computed from the rows alone, so the live engine
 * and the replay agree on it (bar `safeDistanceM`, which follows the detectors).
 */
export interface MovementMark {
  /** `ts` of the movement row; the drive's last movement ends one row later. */
  rowTs: number;
  rowsCount: number;
  validGnssRows: number;
  mockRows: number;
  movingRows: number;
  imuActiveRows: number;
  distanceM: number;
  safeDistanceM: number;
  nightDistanceM: number;
  maxSpeedMps: number;
  lastFix: Fix | null;
  /** `track.length` right after the row. */
  trackLength: number;
}

/** The movement rule's running state (`session.ts`). Replaced on every row, never mutated. */
export interface MotionTrack {
  /** Consecutive pace rows (trusted speed over 5 mph) ending at the latest row. */
  paceRun: number;
  /** Any of them had a fix worse than `MAX_H_ACC_M`. */
  paceRunPoor: boolean;
  /** `ts` of the latest pace row. */
  lastPaceTs: number | null;
  /** Where place movement is measured from. */
  anchor: { lat: number; lng: number; hAcc: number } | null;
  /** No anchor is set before this `ts` (a position jump settling). */
  anchorAfter: number | null;
  /** The previous valid fix was already past the place threshold. */
  placePending: boolean;
  /** Rows with a known speed since the anchor was set, and how many of them were at walking pace. */
  speedRows: number;
  walkRows: number;
  /** Of those, the rows from a carried phone (`session.carried`): a crawl needs few. */
  carriedRows: number;
  /** End of the latest row that held the clock since the last movement (fix-less, or a crawl). */
  heldUntil: number | null;
  /** The previous row was a driving row (`session.drivingRow`). */
  prevDrive: boolean;
}

/**
 * One drive as the engine accumulates it. Mutable while open; the finalizer receives a frozen
 * copy once.
 */
export interface TripSession {
  clientTripId: string;
  /** epoch ms of the Start tap. */
  startedAt: number;
  /** epoch ms where driving stopped; null while open. */
  endedAt: number | null;
  endCause: EndCause | null;
  lastRowTs: number | null;
  rowsCount: number;
  validGnssRows: number;
  /** Rows whose fix came from a mock provider. */
  mockRows: number;
  /** Rows with a known speed at or above 5 mph, and how many of them showed any IMU activity. */
  movingRows: number;
  imuActiveRows: number;
  /** Haversine over consecutive valid fixes, metres (GNSS jumps skipped). */
  distanceM: number;
  /** Distance outside active speeding and phone episodes. */
  safeDistanceM: number;
  /** Distance driven after sunset / before sunrise at the car's position. */
  nightDistanceM: number;
  maxSpeedMps: number;
  firstFix: Fix | null;
  lastFix: Fix | null;
  track: TrackPoint[];
  events: DetectedEvent[];
  /** Rows the recorder has not made durable yet, oldest first. */
  pending: FeatureRow[];
  /** `ts` of the last durable row. */
  checkpointTs: number | null;
  warmup: Readonly<Warmup>;
  /** The latest movement (`session.ts`), or null while the car has not moved. */
  moved: Readonly<MovementMark> | null;
  /**
   * The movement marks of the last `MARK_KEEP_MS` before the newest, oldest first; `moved` is the
   * last. Frozen and replaced, never mutated. The walking end cuts at one of them.
   */
  marks: readonly Readonly<MovementMark>[];
  /**
   * `ts` of the row that completed the drive's first two consecutive driving rows (a known, trusted
   * GPS speed of 10 mph or more): the car reached driving speed. Null until then; never changes after.
   */
  droveAt: number | null;
  /**
   * `ts` of the latest row that completed two consecutive driving rows: the car was last at driving
   * speed. Null until `droveAt`, which it equals at first. An on-foot report is void once this is
   * at or after the moment its walk began (`machine.ts`).
   */
  lastDroveAt: number | null;
  /** The last known GPS speed (any accuracy) and its row `ts`; null before the first. */
  lastSpeed: Readonly<{ mps: number; ts: number }> | null;
  motion: Readonly<MotionTrack>;
  /** Closed at its last movement (`closeAtLastMovement`): the tail after it is left out. */
  cut: boolean;
}

/** An alert the engine raised: the alert layer plays it, the HUD glows for 1.5 s. */
export interface AlertEvent {
  id: string;
  type: EventType;
  tier: Tier;
  /** epoch ms, row clock */
  at: number;
  /**
   * `switch`: a phone alert raised while a screen switch counts; its voice line is "Back to RoadWise".
   * Local only (never stored or uploaded); level, tone, haptic and the HUD word are unchanged.
   */
  words?: 'switch';
}

export interface EngineSnapshot {
  status: EngineStatus;
  clientTripId: string | null;
  startedAt: number | null;
  lastRowTs: number | null;
  /**
   * The speed to show, m/s: the known speed, or 0 while it is below its own accuracy rating and
   * under 3 mph (`motion.shownSpeed`); 0 when unknown — read `speedKnown` first (unknown is "—").
   * `stopped` and `lockedOut` read the raw speed.
   */
  speedMps: number;
  /** The CURRENT row has a known speed. False before the first row and on every row that lost the fix. */
  speedKnown: boolean;
  limit: LimitSample;
  /** The limit to show and judge against, whole mph; null → "—" (unknown, low-confidence or hAcc > 20 m). */
  limitMph: number | null;
  /** The speeding tier of the current row's episode, for the driving screen's halo. */
  speedingTier: Tier | null;
  /**
   * The confirmed phone episode's first use row (row clock), while it is open and recording; else
   * null (before confirmation, a parking-lot episode, no episode). The halo's distraction ramp.
   */
  phoneUseSince: number | null;
  /** Known speed at or below 5 mph: points may show. */
  stopped: boolean;
  /** epoch ms the drive ends by itself unless the car moves (`session.autoEndAt`); null unless recording. */
  autoEndAt: number | null;
  distanceM: number;
  /** Recording at a last known speed (`session.lastSpeed`) above 5 mph: the UI shows only the End control. */
  lockedOut: boolean;
  lastAlert: AlertEvent | null;
}

export interface EngineDeps {
  now(): number;
  /** A fresh `clientTripId` / event id. */
  newId(): string;
  limits: {
    /** The cached limit for a fix, or null when nothing is cached (treated as unknown). */
    lookup(lat: number, lng: number, course: number): LimitSample | null;
    /** Warm the cache along the heading; called once per `PREFETCH_EVERY_M` travelled. */
    prefetch(lat: number, lng: number, course: number): void;
  };
  /** A fresh detector suite for each drive. */
  createDetectors(): DetectorSuite;
  /** The per-row detector context minus `warmupEndsAt`, which the engine knows. */
  ctx(): Omit<DetectorContext, 'warmupEndsAt'>;
  onAlert(alert: AlertEvent): void;
  /** Every `CHECKPOINT_ROWS` rows and before finalize. Owns persistence; a rejection leaves the rows pending. */
  onCheckpoint(session: Readonly<TripSession>): Promise<void>;
  /** Once per drive with the closed session; the finalizer stores and queues it. */
  onFinalize(session: Readonly<TripSession>): Promise<void>;
  /** Failures that must not stop the engine (a finalizer that threw, a subscriber that threw). */
  onError?(err: unknown): void;
}

/** A drive the previous process was recording, rebuilt from its durable rows (`rebuildFromSamples`). */
export interface AdoptedTrip {
  session: TripSession;
  detectors: DetectorSuite;
}

export type EngineEvent =
  /** `continues`: the phone's previous drive ended within `MERGE_GAP_S` (the host reads it at the tap). */
  | { type: 'start'; ts: number; continues: boolean }
  | { type: 'row'; row: FeatureRow }
  /**
   * An OS motion-activity report (`parseActivity`), for the walking end (`motion.ts`). `ts`: the
   * host's clock at arrival, used only before the drive's first row.
   */
  | { type: 'motion'; activity: MotionActivity; ts: number }
  /** A manual end (the End swipe, the notification's End drive, sign-out): cut after 2 min standing still. */
  | { type: 'end'; ts: number }
  /** The host's one timer: the automatic end (`autoEndAt`) may have passed with no row. */
  | { type: 'tick'; ts: number }
  /** Continue a drive the previous process was recording. Applied only while idle. */
  | { type: 'adopt'; trip: AdoptedTrip; ts: number };

export interface Engine {
  /** Serialised: a dispatch never starts before the previous one has settled. */
  dispatch(event: EngineEvent): Promise<void>;
  /** A frozen copy of the current state. */
  snapshot(): EngineSnapshot;
  /** The open session, read-only, or null (the host's points estimate reads it). */
  session(): Readonly<TripSession> | null;
  /** Called with a fresh snapshot after every state change; returns the unsubscribe. */
  subscribe(fn: (snapshot: EngineSnapshot) => void): () => void;
}
