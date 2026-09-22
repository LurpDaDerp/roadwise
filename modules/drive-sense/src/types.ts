// The drive-sense contract: what the Swift (N2) and Kotlin (N3) modules implement and what the
// drive host (H1/H2) consumes. README.md is the prose version; this file is the binding one.
import type { FeatureRow } from '../../../src/core/engine/types';
import type { ExtractedRow } from './extract/types';

export type { FeatureRow };

export type CaptureMode = 'mounted' | 'pocket' | 'auto';
/** rev1: I5 — `low` = coarse location, no IMU, rows only when a fix arrives. */
export type CaptureRate = 'full' | 'low';
export type ThermalLevel = 'nominal' | 'fair' | 'serious' | 'critical';
export type WakeReason = 'significantChange' | 'activityTransition' | 'boot' | 'geofence';

export interface MotionActivity {
  type: 'automotive' | 'walking' | 'running' | 'cycling' | 'stationary' | 'unknown';
  confidence: 'low' | 'medium' | 'high';
  /** epoch ms, integer */
  ts: number;
}

export interface DriveSenseState {
  armed: boolean;
  capturing: boolean;
  /** null while not capturing */
  rate: CaptureRate | null;
  /** null while not capturing */
  mode: CaptureMode | null;
  platform: 'ios' | 'android';
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

export type DriveSenseEvents = {
  wake: { reason: WakeReason; ts: number };
  activity: MotionActivity;
  /** a `FeatureRow` as native emitted it — validate with `parseRow` before use */
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
 * lists in `ios/DriveSenseModule.swift` and `android/.../DriveSenseModule.kt` (N2's and N3's text
 * tests compare them).
 */
export const DRIVE_SENSE_EVENTS = [
  'wake',
  'activity',
  'row',
  'screen',
  'thermal',
  'notificationAction',
  'call',
] as const;

/**
 * Every `DriveSenseApi` method that crosses the bridge, in declaration order (`addListener` is the
 * Expo event emitter's, not an `AsyncFunction`). N2's and N3's text tests assert each appears as
 * `AsyncFunction("<name>")` in the native module.
 */
export const DRIVE_SENSE_METHODS = [
  'arm',
  'disarm',
  'startCapture',
  'stopCapture',
  'setCaptureRate',
  'getState',
  'queryMotionHistory',
  'getScreenState',
  'getThermalState',
  'requestMotionPermission',
  'excludeFromBackup',
  'setNotificationState',
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
  /** `arm()`: location is not 'always' or motion is not 'granted'. `startCapture()`: no location
   * permission at all, or (Android) the OS refused a location foreground service for lack of it. */
  'E_PERMISSION',
  /** The hardware or service is missing: no motion-activity support, no Google Play services. */
  'E_UNAVAILABLE',
  /** Android `startCapture()`: the OS refused to start the foreground service for another reason
   * (background-start restrictions). */
  'E_FGS_REFUSED',
  /** `excludeFromBackup()` (iOS): nothing exists at the URI. */
  'E_NOT_FOUND',
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
  /** Start OS-delivered wakes only (significant change + exit region on iOS; activity transitions on Android). No GPS. */
  arm(): Promise<void>;
  disarm(): Promise<void>;
  /**
   * Start (or keep) full-rate capture in `mode`. Also the JS *claim* of a natively started
   * capture (rev1: C2): the watchdog stops an unclaimed capture after 60 s. Idempotent: while
   * already capturing it only updates the mode and claims.
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
  /** Android S3 notification (End drive action only while stationary); iOS no-op. */
  setNotificationState(state: { stationary: boolean; startedAt: number | null }): Promise<void>;
  /** Android ApplicationExitInfo (+ 'watchdog' from the persisted record); iOS null. */
  getLastExitInfo(): Promise<ExitInfo | null>;
  /**
   * Android: `PowerManager.isIgnoringBatteryOptimizations(packageName)` — whether the app is
   * exempt from battery optimisation, which decides whether background drive detection survives
   * Doze (M4 permission health). iOS: always resolves `true` — iOS has no equivalent per-app
   * restriction to report, so there is nothing for the user to fix.
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
  /** Deliver an event as native would. With no listener for it attached, it is buffered (README §Buffering). */
  emit<E extends DriveSenseEvent>(event: E, payload: DriveSenseEvents[E]): void;
  /** Queue rows for `step`/`drain` (replaces any rows still queued). */
  loadTrace(rows: readonly FeatureRow[]): void;
  /** Emit the next queued row as a `row` event; false when the queue is empty. */
  step(): boolean;
  /** `step` until the queue is empty. */
  drain(): void;
  /** Every API method call, in order: the method name, plus `:<arg>` for startCapture, setCaptureRate and excludeFromBackup. */
  calls: string[];
  setMotionHistory(a: MotionActivity[]): void;
  setState(s: Partial<DriveSenseState>): void;
  // ——— additions beyond the brief (see the N1 report) ———
  /** JS listeners currently attached for `event` — the watchdog's liveness signal for `row`. */
  listenerCount(event: DriveSenseEvent): number;
  /** What `getLastExitInfo` resolves to (null by default). */
  setLastExitInfo(info: ExitInfo | null): void;
  /** What `isIgnoringBatteryOptimizations` resolves to (default: true on iOS, false on Android). */
  setIgnoringBatteryOptimizations(value: boolean): void;
  /** The last `setNotificationState` argument, or null. */
  readonly notificationState: { stationary: boolean; startedAt: number | null } | null;
}

// `ExtractedRow` (the reference's own copy of the row shape) and M1's `FeatureRow` must stay
// identical: each assignment below fails `tsc` if a field is added to, removed from or retyped in
// one of them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const rowShapesAgree: Same<ExtractedRow, FeatureRow> = true;
void rowShapesAgree;
