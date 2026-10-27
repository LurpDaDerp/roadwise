// The `DriveDetect` contract (plan §3.1.1): the iOS drive detector's bridge, a second Expo module in
// the drive-sense pod (`ios/DriveDetectModule.swift`). Android, Jest, Expo Go and web have no such
// module: `DriveDetect.available` is false there and every method but `wipe` and `appForeground` rejects
// (they resolve). The shared `DriveSense` contract (`../types.ts`) is unchanged by it apart from the
// bridge-only `seq` on rows.
import type { DetectMissing, DetectPhase, DetectStatus, StartSource } from './policy';

export type { DetectMissing, DetectPhase, DetectStatus, StartSource };

/** Keep identical to `Events(...)` in `ios/DriveDetectModule.swift` (the native text test compares them). */
export const DRIVE_DETECT_EVENTS = ['detectState', 'driveStarted', 'driveEnded'] as const;

/** One `AsyncFunction` each in `ios/DriveDetectModule.swift`. */
export const DRIVE_DETECT_METHODS = [
  'setArmed',
  'getState',
  'requestAlways',
  'startWaiting',
  'extendWaiting',
  'cancelWaiting',
  'notDriving',
  'listDrives',
  'readRows',
  'discardDrive',
  'wipe',
  'appForeground',
] as const;

/** `discardDrive` on the live drive. Every other method never rejects. */
export const DRIVE_DETECT_ERROR_CODES = ['E_BUSY'] as const;

export type DriveDetectMethod = (typeof DRIVE_DETECT_METHODS)[number];
export type DriveDetectErrorCode = (typeof DRIVE_DETECT_ERROR_CODES)[number];

export type DriveOrigin = 'auto' | 'manual';
/** Why native stopped sensing on its own ('js' is journaled but never crosses as an event). */
export type EndCauseNative = 'still' | 'walking' | 'limit' | 'orphan' | 'cancelled';

export interface DetectPermissions {
  location: 'none' | 'whenInUse' | 'always';
  precise: boolean;
  motion: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  backgroundRefresh: 'available' | 'denied' | 'restricted';
  /** `ActivityAuthorizationInfo().areActivitiesEnabled` */
  liveActivities: boolean;
  /** The one-shot Always request is still available (While Using held, not yet asked). */
  canAskAlways: boolean;
}

export interface DetectLastEndState {
  /** When the end was decided. */
  decidedAt: number;
  /** The JS cut when JS ended it, else = decidedAt. */
  cut: number;
  lat: number;
  lng: number;
  driveId: string;
}

export interface DetectState {
  /** Detection runs: JS armed it and the permissions hold. */
  armed: boolean;
  ownerId: string | null;
  state: DetectPhase;
  origin: DriveOrigin | null;
  /** The live drive (recording or ending); = the JS client_trip_id (lowercase UUID). */
  driveId: string | null;
  /** The live drive's traced start, epoch ms. */
  startedAt: number | null;
  /** When the state was entered, epoch ms. */
  since: number;
  /** A Start-card drive still waiting for driving speed: its deadline (5 min from the tap or the last touch). */
  waitUntil: number | null;
  lastEnd: DetectLastEndState | null;
  /** The 3 h cap while suppressed. */
  suppressedUntil: number | null;
  status: DetectStatus;
  /** Non-empty only with status 'needs'. */
  missing: DetectMissing[];
  permissions: DetectPermissions;
  /** Journal files rotated away undrained since the last `getState`. */
  journalDropped: number;
}

export interface DriveStartedEvent {
  driveId: string;
  origin: DriveOrigin;
  startedAt: number;
  startSource: StartSource;
  startLat: number | null;
  startLng: number | null;
  /** Native's warm-up hint: within 5 min and 150 m of the last end (JS decides the warm-up itself). */
  continues: boolean;
  confirmedAt: number;
  firstSeq: number;
}

export interface DriveEndedEvent {
  driveId: string;
  endedAt: number;
  cause: EndCauseNative;
  decidedAt: number;
  lastSeq: number;
  lastRowTs: number | null;
}

export type DetectReason =
  | 'armed'
  | 'disarmed'
  | 'wake:slc'
  | 'wake:region'
  | 'wake:visit'
  | 'wake:app'
  | 'linger'
  | 'waiting'
  | 'extended'
  | 'confirmed'
  | 'timeout'
  | 'cap'
  | 'waitTimeout'
  | 'cancelled'
  | 'walking'
  | 'stillClock'
  | 'moved'
  | 'ended'
  | 'notDriving'
  | 'suppressionEnded'
  | 'resumed'
  | 'permissionLost';

export const DETECT_REASONS: readonly DetectReason[] = [
  'armed',
  'disarmed',
  'wake:slc',
  'wake:region',
  'wake:visit',
  'wake:app',
  'linger',
  'waiting',
  'extended',
  'confirmed',
  'timeout',
  'cap',
  'waitTimeout',
  'cancelled',
  'walking',
  'stillClock',
  'moved',
  'ended',
  'notDriving',
  'suppressionEnded',
  'resumed',
  'permissionLost',
];

export interface DetectStateEvent extends DetectState {
  reason: DetectReason;
}

export interface JournaledDrive {
  driveId: string;
  origin: DriveOrigin;
  startedAt: number;
  startSource: StartSource;
  startLat: number | null;
  startLng: number | null;
  continues: boolean;
  confirmedAt: number;
  firstSeq: number;
  /** 0 before any row. */
  lastSeq: number;
  lastRowTs: number | null;
  bytes: number;
  ended: { endedAt: number; cause: EndCauseNative | 'js'; decidedAt: number } | null;
}

export type DriveDetectEvents = {
  detectState: DetectStateEvent;
  driveStarted: DriveStartedEvent;
  driveEnded: DriveEndedEvent;
};

export type DriveDetectEvent = keyof DriveDetectEvents;

/**
 * `ok`: the drive opened at the tap (`driveId`, `startedAt`), waiting for driving speed until
 * `waitUntil`. A native build from before the drive opened at the tap answers only `{ ok, waitUntil }`:
 * then `driveId` and `startedAt` are null (`getState` has the drive, if one records).
 */
export type StartWaitingResult =
  | { ok: true; waitUntil: number; driveId: string | null; startedAt: number | null }
  | { ok: false; reason: 'permission' | 'busy' | 'unavailable' };

export interface ReadRowsResult {
  /** `row` event payloads with their `seq`: validate each with `parseRow`. */
  rows: unknown[];
  lastSeq: number;
  done: boolean;
}

export interface DetectSubscription {
  remove(): void;
}

export interface DriveDetectApi {
  /** False on Android, Jest, Expo Go and web: every method but `wipe` and `appForeground` then rejects and every listener is inert. */
  readonly available: boolean;
  /** Arms (needs Always + Precise + Motion, else resolves status 'needs' and stays off) or disarms. Never rejects. */
  setArmed(armed: boolean, ownerId: string): Promise<DetectState>;
  getState(): Promise<DetectState>;
  /** The one Always request, only from While Using, once per install; otherwise the current answer. */
  requestAlways(): Promise<'always' | 'whenInUse' | 'denied'>;
  /**
   * The Start card: a manual drive opens at once, from the tap, journaled like any drive and announced
   * with `driveStarted` (While Using + Precise is enough; the app is in front). It waits for driving
   * speed (two trusted readings at 10 mph or more in a row, as JS's wait) until `waitUntil` (5 min):
   * meanwhile native's safety stop never ends it on a walk, and on the still clock only past that
   * deadline. JS ends it unsaved at the deadline; a relaunch ends native's wait too.
   */
  startWaiting(): Promise<StartWaitingResult>;
  /** Any touch while the Start-card drive waits: the 5 min start again; the new waitUntil, or null when it waits no more. */
  extendWaiting(): Promise<number | null>;
  cancelWaiting(): Promise<void>;
  /** "Not driving?": cancel the live drive (journal deleted) and suppress detection. No-op when nothing records. */
  notDriving(): Promise<void>;
  listDrives(): Promise<JournaledDrive[]>;
  /** Rows with seq > afterSeq, in order, at most `limit` (1-600); `done` when the file holds no more. */
  readRows(driveId: string, afterSeq: number, limit: number): Promise<ReadRowsResult>;
  /** Deletes the journal file; resolves even when none exists; rejects E_BUSY for the live drive. */
  discardDrive(driveId: string): Promise<void>;
  /**
   * The sign-out, device and account-switch wipes: any candidate, Start-card wait, recording drive
   * or "Not driving?" rest stops (no `driveEnded`: JS ends its own drive first), EVERY journal file is
   * deleted, the last end, the parked region, the rest and the drive are forgotten, and the detector
   * is left off with no owner (a later `setArmed(true, owner)` arms it again). Resolves once the
   * files are gone. On Android, or with no native module, a no-op that resolves.
   */
  wipe(): Promise<void>;
  /**
   * RoadWise came to the front: an `app` wake (the native detector also takes one by itself on
   * `didBecomeActive`). Like a significant-change wake it opens an auto candidate only with car
   * motion in the last 2 min, the driver not on foot, but it ignores the rest after an empty
   * candidate; nothing while disarmed, watching, recording or resting. On Android, or with no
   * native module (or a native build without it), a no-op that resolves.
   */
  appForeground(): Promise<void>;
  /** A payload that fails validation is dropped (counted by `droppedDetectEvents`), never passed on. */
  addListener<E extends DriveDetectEvent>(event: E, fn: (p: DriveDetectEvents[E]) => void): DetectSubscription;
}
