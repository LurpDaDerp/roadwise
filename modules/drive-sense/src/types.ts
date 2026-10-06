// The drive-sense contract: what the Swift and Kotlin modules implement and what the drive host
// consumes. README.md is the prose version; this file is the binding one.
//
// v3 (plan §1 decision 4, §6): drives start only from a tap in the app. There is no arming, no
// OS wake, no auto-start, no "Always" location anywhere in this module. Native captures only
// between a JS `startCapture` and `stopCapture` (plus the Android sticky restart of a capture the
// user already started, under the watchdog).
import type { FeatureRow } from '../../../src/core/engine/types';
import type { ExtractedRow } from './extract/types';

export type { FeatureRow };

export type CaptureMode = 'mounted' | 'pocket' | 'auto';
/** rev1: I5 — `low` = coarse location, no IMU, rows only when a fix arrives. */
export type CaptureRate = 'full' | 'low';
export type ThermalLevel = 'nominal' | 'fair' | 'serious' | 'critical';

/**
 * A `row` as the bridge hands it to JS: M1's `FeatureRow` plus `mock` — whether the fix behind the
 * row came from a mock location provider (Android `Location.isMock()` / `isFromMockProvider()`;
 * iOS 15+ `sourceInformation?.isSimulatedBySoftware`). Optional: rows persisted before v3 and rows
 * from an older native build parse without it, and a consumer reads absent as "not known to be
 * mocked". Integrity (spec "GPS spoofing") reads it; the extractor never does.
 */
export interface DriveSenseRow extends FeatureRow {
  mock?: boolean;
}

export interface MotionActivity {
  type: 'automotive' | 'walking' | 'running' | 'cycling' | 'stationary' | 'unknown';
  confidence: 'low' | 'medium' | 'high';
  /** epoch ms, integer */
  ts: number;
  /**
   * DMS calib T12 (README §3): Android only, the END of a walking or running transition (EXIT). Live
   * `activity` events only; never in `queryMotionHistory`. An exit is never a walk: the host times a
   * walk from its ENTER to its EXIT (or to an IN_VEHICLE).
   */
  exit?: true;
}

export interface DriveSenseState {
  capturing: boolean;
  /** null while not capturing */
  rate: CaptureRate | null;
  /** null while not capturing */
  mode: CaptureMode | null;
  platform: 'ios' | 'android';
  /**
   * The OS location authorisation. The app never asks for Always (plan §1 decision 4); `always`
   * is reported only when the user granted it in Settings on their own, and nothing here needs it.
   */
  location: 'none' | 'whenInUse' | 'always';
  motion: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  /**
   * rev1: I11 — iOS: 'unreliable' without a passcode (isProtectedDataAvailable never goes false),
   * 'lagged' with one (~10 s); Android 'reliable'.
   */
  lockSignal: 'reliable' | 'lagged' | 'unreliable';
  /** rev1: I2 — a capture was open when the process last ended (persisted natively). */
  captureWasOpen: boolean;
  /** epoch ms (integer) the current capture started; null while not capturing */
  captureStartedAt: number | null;
  /** epoch ms of the last row emitted in this process; null before any */
  lastRowTs: number | null;
}

export interface ExitInfo {
  /** epoch ms, integer */
  ts: number;
  reason: 'user_stopped' | 'low_memory' | 'crash' | 'anr' | 'watchdog' | 'other' | 'unknown';
  whileCapturing: boolean;
}

/**
 * What the background surface shows (plan §6): the Android foreground notification and, on iOS,
 * the Live Activity (forwarded natively when one is running). Callers throttle to ≤ 1 update per
 * 3 s and only on change. `null` speed or limit shows "—". `points` is shown only when non-null
 * (the host passes it only while stopped).
 */
export interface DriveDisplayState {
  speed: number | null;
  limit: number | null;
  unit: 'mph' | 'km/h';
  points: number | null;
  pointsDelta: number | null;
  /** ≤ 5 mph: the Android notification offers its End drive action only while stopped. */
  stopped: boolean;
  /** The drive is over: the surface shows its final state (the Live Activity dismisses soon). */
  ended?: boolean;
}

/** iOS `checkForgottenDrive`: a confident automotive stretch of at least 5 minutes. */
export interface ForgottenDrive {
  /** epoch ms, integer */
  startedAt: number;
  /** epoch ms, integer */
  endedAt: number;
}

export type DriveSenseEvents = {
  activity: MotionActivity;
  /** a `DriveSenseRow` as native emitted it — validate with `parseRow` before use */
  row: unknown;
  screen: { locked: boolean; on: boolean; ts: number };
  thermal: { level: ThermalLevel; ts: number };
  notificationAction: { action: 'endDrive'; ts: number };
  /** iOS only */
  call: { active: boolean; ts: number };
};

export type DriveSenseEvent = keyof DriveSenseEvents;

/**
 * The event names both native modules declare. Keep this list byte-identical to the `Events(...)`
 * lists in `ios/DriveSenseModule.swift` and `android/.../DriveSenseModule.kt` (the native text
 * tests compare them).
 */
export const DRIVE_SENSE_EVENTS = [
  'activity',
  'row',
  'screen',
  'thermal',
  'notificationAction',
  'call',
] as const;

/**
 * Every `DriveSenseApi` method that crosses the bridge, in declaration order (`addListener` is the
 * Expo event emitter's, not an `AsyncFunction`). The native text tests assert each appears as
 * `AsyncFunction("<name>")` in both native modules.
 */
export const DRIVE_SENSE_METHODS = [
  'startCapture',
  'stopCapture',
  'setCaptureRate',
  'getState',
  'queryMotionHistory',
  'getScreenState',
  'getThermalState',
  'requestMotionPermission',
  'excludeFromBackup',
  'setDriveDisplay',
  'setForgotToStartReminder',
  'checkForgottenDrive',
  'getLastExitInfo',
  'isIgnoringBatteryOptimizations',
  'selfTest',
] as const;

export type DriveSenseMethod = (typeof DRIVE_SENSE_METHODS)[number];

/**
 * The `CodedError` codes a native method may reject with (README §2 "Errors"). Anything else a
 * native method throws is a bug. The wrapper passes these through with their `code`.
 */
export const DRIVE_SENSE_ERROR_CODES = [
  /** `startCapture()`: no location permission at all, or (Android) the OS refused the location
   * foreground service for lack of it. */
  'E_PERMISSION',
  /** Android `startCapture()`: the OS refused to start the foreground service for another reason
   * (background-start restrictions). */
  'E_FGS_REFUSED',
  /** `excludeFromBackup()` (iOS): nothing exists at the URI. */
  'E_NOT_FOUND',
  /** `excludeFromBackup()` (iOS): the file exists but the backup-exclusion attribute could not be set. */
  'E_IO',
  /** `selfTest()`: the vectors JSON could not be parsed at all. */
  'E_INVALID_INPUT',
] as const;

export type DriveSenseErrorCode = (typeof DRIVE_SENSE_ERROR_CODES)[number];

/** Whether `e` is a drive-sense rejection with `code` (Expo `CodedError` carries `.code`). */
export function isDriveSenseError(e: unknown, code?: DriveSenseErrorCode): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return (
    typeof c === 'string' &&
    (DRIVE_SENSE_ERROR_CODES as readonly string[]).includes(c) &&
    (code === undefined || c === code)
  );
}

export interface Subscription {
  remove(): void;
}

export interface DriveSenseApi {
  /**
   * Start (or keep) full-rate capture in `mode`. Also the JS *claim* of a capture native restarted
   * on its own (the Android sticky restart; rev1: C2): the watchdog stops an unclaimed one after
   * 60 s. Idempotent: while already capturing it only updates the mode and claims. Only ever
   * called from a user's tap in the foreground (plan §1 decision 4).
   */
  startCapture(mode: CaptureMode): Promise<void>;
  /** Idempotent; clears the persisted capture-open flag. */
  stopCapture(): Promise<void>;
  /** Ignored (resolves) while not capturing. */
  setCaptureRate(rate: CaptureRate): Promise<void>;
  getState(): Promise<DriveSenseState>;
  /** iOS: CMMotionActivityManager history; Android: the transitions buffered natively over the last 24 h (rev1: m). */
  queryMotionHistory(fromTs: number, toTs: number): Promise<MotionActivity[]>;
  getScreenState(): Promise<{ locked: boolean; on: boolean }>;
  getThermalState(): Promise<ThermalLevel>;
  /** iOS: motion prompt; Android API 29+: the ACTIVITY_RECOGNITION runtime permission (rev1: I15). */
  requestMotionPermission(): Promise<'granted' | 'denied' | 'unavailable'>;
  /** iOS: sets isExcludedFromBackup on the file or directory; Android: resolves (rev1: R4). */
  excludeFromBackup(uri: string): Promise<void>;
  /**
   * The background surface (plan §6). Android: updates the capture's foreground notification
   * (title "Driving"; "34 mph · limit 35"; a points line only when `points` is non-null; the End
   * drive action only while `stopped`); ignored while not capturing. iOS: forwarded to the Live
   * Activity when one is running, else a no-op. Never rejects.
   */
  setDriveDisplay(state: DriveDisplayState): Promise<void>;
  /**
   * The optional forgot-to-start reminder (spec "Starting and ending a drive"; off by default).
   * Android: registers (or removes) a lightweight activity-transition listener — ACTIVITY_RECOGNITION
   * only, no location — that posts a quiet local notification after an IN_VEHICLE exit when no
   * capture ran during that vehicle period (never while in a vehicle, at most once per 6 h, never
   * starts anything). The setting is persisted natively and re-registered on app start while
   * enabled. iOS: persisted only; the app checks `checkForgottenDrive` on foreground instead. Never rejects.
   */
  setForgotToStartReminder(enabled: boolean): Promise<void>;
  /**
   * iOS: the most recent confident automotive stretch of ≥ 5 min in the motion history since
   * `sinceMs`, or null (also null without motion permission). JS decides whether it overlaps a
   * recorded drive and shows the in-app notice. Android: always null (the notification path above
   * covers it). Never rejects.
   */
  checkForgottenDrive(sinceMs: number): Promise<ForgottenDrive | null>;
  /** Android ApplicationExitInfo (+ 'watchdog' from the persisted record); iOS null. */
  getLastExitInfo(): Promise<ExitInfo | null>;
  /**
   * Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether the app is
   * exempt from battery optimisation (permission health). iOS: always resolves `true` — iOS has no
   * equivalent per-app restriction to report, so there is nothing for the user to fix.
   */
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  /** Runs the native extractor over golden vectors; returns a `SelfTestOutput` as JSON (README §Self-test). */
  selfTest(vectorsJson: string): Promise<string>;
  addListener<E extends DriveSenseEvent>(
    event: E,
    fn: (payload: DriveSenseEvents[E]) => void
  ): Subscription;
}

export interface FakeControls {
  /**
   * Deliver an event as native would. With no listener for it attached, it is buffered (README
   * §Buffering). Delivery is synchronous unless the fake was created with `asyncDelivery: true`
   * (native delivery is always asynchronous — use that option in integration tests).
   */
  emit<E extends DriveSenseEvent>(event: E, payload: DriveSenseEvents[E]): void;
  /** Queue rows for `step`/`drain` (replaces any rows still queued). */
  loadTrace(rows: readonly DriveSenseRow[]): void;
  /**
   * Emit the next queued row as a `row` event. Like native, only while capturing: returns false
   * (emitting nothing) when not capturing or when the queue is empty. `{ force: true }` emits
   * regardless, for tests of that edge.
   */
  step(opts?: { force?: boolean }): boolean;
  /** `step` until it returns false. */
  drain(opts?: { force?: boolean }): void;
  /** Rows still queued (e.g. to see that a host stopped capture early). */
  pendingRows(): number;
  /**
   * Commands, in order: startCapture, stopCapture, setCaptureRate, requestMotionPermission,
   * excludeFromBackup, setDriveDisplay, setForgotToStartReminder, selfTest — the method name, plus
   * `:<arg>` for startCapture, setCaptureRate, excludeFromBackup and setForgotToStartReminder.
   * Rejected calls are logged too.
   */
  calls: string[];
  /** Read-only calls, in order: getState, queryMotionHistory, getScreenState, getThermalState, checkForgottenDrive, getLastExitInfo, isIgnoringBatteryOptimizations. */
  queries: string[];
  setMotionHistory(a: MotionActivity[]): void;
  setState(s: Partial<DriveSenseState>): void;
  /** JS listeners currently attached for `event` — the watchdog's liveness signal for `row`. */
  listenerCount(event: DriveSenseEvent): number;
  /** What `getLastExitInfo` resolves to (null by default). */
  setLastExitInfo(info: ExitInfo | null): void;
  /** What `isIgnoringBatteryOptimizations` resolves to (default: true on iOS, false on Android). */
  setIgnoringBatteryOptimizations(value: boolean): void;
  /** The last `setDriveDisplay` argument delivered while capturing, or null (cleared by stopCapture, as the notification goes). */
  readonly driveDisplay: DriveDisplayState | null;
  /** The persisted forgot-to-start setting (default false). */
  readonly forgotToStartReminder: boolean;
  /** What `checkForgottenDrive` resolves to while motion is granted (null by default). */
  setForgottenDrive(d: ForgottenDrive | null): void;
  // ——— DMS calib T12: the native activity feed (README §3) ———
  /**
   * An OS motion-activity delivery as native makes it: an `activity` event only while the feed is
   * subscribed by a capture and the capture runs. Returns whether it was delivered.
   * (`emit('activity', …)` still delivers unconditionally.)
   */
  transition(a: MotionActivity): boolean;
  /** The capture's own subscription fails from now on (Android: a SecurityException). The capture still runs. */
  failCaptureSubscribe(fail: boolean): void;
  /** Whether the activity feed is subscribed now (by a capture, motion granted). */
  readonly activitySubscribed: boolean;
  /**
   * C12 round 1: the capture's registration survives its end (an abnormal end: a kill, a refused restart, a late
   * subscribe). Its first transition, not capturing, removes it and delivers nothing (self-heal).
   */
  strandSubscription(): void;
}

// `ExtractedRow` (the reference's own copy of the row shape) and M1's `FeatureRow` must stay
// identical: each assignment below fails `tsc` if a field is added to, removed from or retyped in
// one of them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const rowShapesAgree: Same<ExtractedRow, FeatureRow> = true;
void rowShapesAgree;
