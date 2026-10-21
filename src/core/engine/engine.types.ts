// The drive engine's contract (product spec "Starting and ending a drive"; modes plan §3.4, §3.9).
//
// Everything the engine knows about the outside world comes in through `EngineDeps` and
// `EngineEvent`; everything it decides goes out through the `EngineDeps` callbacks and
// `EngineSnapshot`. Time is only ever the `ts` on an event or a row.
import type { MotionActivity } from '@drive-sense';
import type { EventType, Tier } from '@scoring';

import type { SpeedFix } from './displaySpeed';
import type { ExposureState } from './exposure';
import type { DetectedEvent, DetectorContext, DetectorSuite, FeatureRow, LimitSample } from './types';

/** idle → recording → finalizing → idle. Nothing starts a drive but `start` (or `adopt`). */
export type EngineStatus = 'idle' | 'recording' | 'finalizing';

/** Why the drive closed. Local only; never uploaded. `limit`: it reached `MAX_DRIVE_MS`. A "Not driving?" cancel is not an end. */
export type EndCause = 'manual' | 'stopped' | 'walking' | 'orphan' | 'limit';

/** How a drive began: noticed by the phone on its own (iOS), or from the Start card's waiting session. */
export type DriveOrigin = 'auto' | 'manual';

/**
 * Where the drive's start time came from: traced back to the last stop before the rise (`trace`),
 * the motion coprocessor's automotive run (`motion`, iOS), or the first row seen (`wake`).
 */
export type StartSource = 'trace' | 'motion' | 'wake';

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
  /** The opportunity counters right after the row (`exposure.ts`): a cut drive counts none of its tail. */
  exposure: Readonly<ExposureState>;
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
  /** epoch ms the drive started: its traced-back start (the waiting session's or native's), or the first row. */
  startedAt: number;
  /** How the drive began. */
  origin: DriveOrigin;
  /** How many times a continuation re-opened this trip (`src/drive/continuation.ts`). Local only. */
  continuations: number;
  /** Where `startedAt` came from; null for a drive rebuilt from a trip row that does not say. */
  startSource: StartSource | null;
  /** The place the drive started when it is not its first row (the parked spot native fell back to), else null. */
  startPlace: { lat: number; lng: number } | null;
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
  /** Distance outside active speeding episodes. */
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
  /** The highest native journal `seq` taken in (iOS; rows without one leave it), or null. Stored at each checkpoint. */
  lastSeq: number | null;
  warmup: Readonly<Warmup>;
  /** The drive's opportunity counters so far (`exposure.ts`): slowdowns, speed-ups, turns, limit time. */
  exposure: Readonly<ExposureState>;
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

/**
 * An alert the engine raised: the alert layer plays it, the HUD glows for 1.5 s (`lastAlert`; a
 * `repeat` is sounded only). `id` is the episode's, which may never become an event (a speeding
 * episode that ends within its grace): use it as a key only.
 */
export interface AlertEvent {
  id: string;
  type: EventType;
  tier: Tier;
  /** epoch ms, row clock */
  at: number;
  /** A speeding repeat while the car stays over the line: the chime, sounded, never shown (never `lastAlert`, so no banner). */
  repeat?: true;
}

/**
 * The halo shakes on it: a hard brake, start or turn as it is confirmed, a speeding episode as its
 * grace ends. Two on the same row are one shake (the later key wins). Never a DashPal alert.
 */
export interface EventShake {
  /** Unique per shake in a drive. */
  key: string;
  /** epoch ms, row clock: the row it happened on. */
  at: number;
  /** The event's tier so far: the shake's size. */
  tier: Tier;
}

export interface EngineSnapshot {
  status: EngineStatus;
  clientTripId: string | null;
  /** How the open drive began; null when not recording. */
  origin: DriveOrigin | null;
  startedAt: number | null;
  lastRowTs: number | null;
  /**
   * The speed to show at `speedAt`, m/s (`displaySpeed.ts`): the Kalman estimate from each fix's
   * Doppler speed, 0 for a car standing still or creeping under 3 mph, held through lost fixes (0
   * once the car is still), 0 before the first fix of a drive.
   * `stopped`, `lockedOut` and every detector read the raw row speed.
   */
  speedMps: number;
  /**
   * The acceleration (m/s²) the screen carries `speedMps` on with from `speedAt`
   * (`displaySpeed.carriedSpeed`); 0 when cruising, shown as 0 or before any fix.
   */
  speedAccelMps2: number;
  /** The time `speedMps` stands for (the last measured fix's, host clock), or null before any. */
  speedAt: number | null;
  /** The newest row's known GPS speed (m/s), null when it had none: the halo's speeding hold. */
  rowSpeedMps: number | null;
  /** There is a speed to show: always during a drive (the screen never shows "—" for it); false with no drive. */
  speedKnown: boolean;
  limit: LimitSample;
  /**
   * The limit the sign shows, whole mph: a posted limit or, on a road with none, its class default
   * (`limit.source` says `statutory`; shown, never scored); a row with none (unknown, low-confidence
   * or hAcc > 20 m) keeps the last one for up to 10 s (`displayLimit.ts`), then null → "-". Display
   * only: the detectors judge each row against its own `limit` (`limitMphFor`).
   */
  limitMph: number | null;
  /** The speeding tier of the current row's episode, for the driving screen's halo. */
  speedingTier: Tier | null;
  /**
   * The current row's GPS speed over the posted limit speeding is judged on (`limitMphFor`: never a
   * class default, a ramp's or a held display limit), on a row the speeding detector can use (a
   * trusted speed on a good fix past the warm-up); null otherwise and when not recording. 1 is at
   * the limit. The driving screen's halo tints from it.
   */
  speedingRatio: number | null;
  /** The current row is over the speeding line (L + T): the halo pulses. False when not recording. */
  speedingOver: boolean;
  /**
   * The last GPS course, degrees clockwise from true north, from a valid fix with a known course
   * while moving at 5 mph or more (`COURSE_MIN_MPS`); held while slower or without a course; null
   * before the drive's first and when not recording. The driving screen's compass.
   */
  courseDeg: number | null;
  /**
   * The latest event the halo shakes on (`EventShake`), or null before the first of the drive and
   * when not recording. The driving screen shakes on each new `key`.
   */
  lastShake: EventShake | null;
  /** Known speed at or below 5 mph (`MOVING_MIN_MPH`). */
  stopped: boolean;
  /** epoch ms the drive ends by itself unless the car moves (`session.autoEndAt`); null unless recording. */
  autoEndAt: number | null;
  distanceM: number;
  /** Recording at a last known speed (`session.lastSpeed`) above 5 mph: the UI shows only the End control. */
  lockedOut: boolean;
  lastAlert: AlertEvent | null;
}

/** A row's fix as the speed-limit lookup reads it. */
export interface LimitFix {
  gnssValid: boolean;
  /** The row's known speed, m/s; null when unknown. */
  speedMps: number | null;
}

export interface EngineDeps {
  now(): number;
  /** A fresh `clientTripId` / event id. */
  newId(): string;
  limits: {
    /**
     * The cached limit for a fix, or null when nothing is cached (treated as unknown). `fix` is the
     * row's: the lookup holds the last limit while stopped, drops it on a lost fix, and asks for a
     * point answer after a run of unknown limits while moving.
     */
    lookup(lat: number, lng: number, course: number, fix?: LimitFix): LimitSample | null;
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
  /** "Not driving?": the open drive is discarded; drop what was stored. Nothing is scored or uploaded. */
  onCancel(session: Readonly<TripSession>): Promise<void>;
  /** Failures that must not stop the engine (a finalizer that threw, a subscriber that threw). */
  onError?(err: unknown): void;
}

/** A drive the previous process was recording, rebuilt from its durable rows (`rebuildFromSamples`). */
export interface AdoptedTrip {
  session: TripSession;
  detectors: DetectorSuite;
}

export type EngineEvent =
  /**
   * A confirmed drive. `ts`: its traced-back start; `clientTripId`: native's drive id (default a
   * fresh one); `continues`: the phone's previous drive ended within `MERGE_GAP_S` (no warm-up).
   */
  | {
      type: 'start';
      ts: number;
      clientTripId?: string;
      origin: DriveOrigin;
      continues: boolean;
      startSource?: StartSource;
      startPlace?: { lat: number; lng: number } | null;
    }
  | { type: 'row'; row: FeatureRow }
  /**
   * An OS motion-activity report (`parseActivity`), for the walking end (`motion.ts`). `ts`: the
   * host's clock at arrival, used only before the drive's first row.
   */
  | { type: 'motion'; activity: MotionActivity; ts: number }
  /**
   * An end. Without `cause`, a manual end (the End swipe, the notification's End drive, sign-out):
   * cut after 2 min standing still. With one (native stopped sensing on its own), cut at the last movement.
   */
  | { type: 'end'; ts: number; cause?: EndCause }
  /** "Not driving?": the drive is discarded (`deps.onCancel`), never finalized. Only while recording. */
  | { type: 'cancel'; ts: number }
  /**
   * Let the open drive go without ending it: checkpointed as it stands and left `recording` in
   * storage, for a later launch to take up (a journal that could not be read to its end). Only
   * while recording.
   */
  | { type: 'release'; ts: number }
  /** The host's one timer: the automatic end (`autoEndAt`) may have passed with no row. */
  | { type: 'tick'; ts: number }
  /** Continue a drive the previous process was recording (or a re-opened one). Applied only while idle. */
  | { type: 'adopt'; trip: AdoptedTrip; ts: number };

export interface Engine {
  /** Serialised: a dispatch never starts before the previous one has settled. */
  dispatch(event: EngineEvent): Promise<void>;
  /** A frozen copy of the current state. */
  snapshot(): EngineSnapshot;
  /** The open session, read-only, or null. */
  session(): Readonly<TripSession> | null;
  /** Called with a fresh snapshot after every state change; returns the unsubscribe. */
  subscribe(fn: (snapshot: EngineSnapshot) => void): () => void;
  /**
   * A GPS fix's speed the moment it lands (native's `speed` event), for the screen's number only.
   * Not serialised behind the rows: it changes nothing but the display speed, at once, and only
   * while recording.
   */
  speed(fix: SpeedFix): void;
}
