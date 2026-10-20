// The drive-sense contract: what the Swift and Kotlin modules implement and what the drive host
// consumes. README.md is the prose version; this file is the binding one.
//
// v3 (plan §1 decision 4, §6): drives start only from a tap in the app. There is no arming and no
// auto-start. Native captures only between a JS `startCapture` and `stopCapture` (plus the Android
// sticky restart of a capture the user already started, under the watchdog).
//
// The one thing that runs with no drive open is the optional forgot-to-start reminder (off by
// default; README "Forgot-to-start reminder"): it notices driving natively and posts at most one
// notification a session, which carries a one-use token. JS switches it (`setTripReminder`) and
// reads its status. It never starts a capture: a tap on its note reaches JS (iOS through
// expo-notifications, Android through `takeReminderTap`), JS claims the token
// (`claimReminderTap`) and only then starts the drive itself, through the Start Drive path. On iOS it
// is the only reason the app asks for "Always" location, and only when the driver turns it on
// (`requestReminderLocation`).
import type { FeatureRow } from '../../../src/core/engine/types';
import type { ExtractedRow } from './extract/types';
import type { TripReminderMissing, TripReminderStatus } from './reminder/policy';

export type { FeatureRow, TripReminderMissing, TripReminderStatus };

/**
 * `requestReminderLocation()`: iOS location after the one "Always" request (`whenInUse` = the
 * driver kept While Using); Android `notNeeded` (its reminder uses no location).
 */
export type ReminderLocationAnswer = 'always' | 'whenInUse' | 'denied' | 'notNeeded';

/** A tap on the reminder's note as Android hands it to JS: its token, and when it was handed over (epoch ms). */
export interface ReminderTap {
  token: string;
  at: number;
}

/** An installed app `listInstalledApps` found: its package and its own label. */
export interface InstalledApp {
  package: string;
  label: string;
}

/**
 * `audioOutputState()`: what a DashPal alert would play into right now (README §2). `callActive`:
 * a call is ringing or live (iOS `CXCallObserver`, a fresh read; Android the audio mode, as the
 * rows' `call` key reads it). `volume`: the media volume 0-1 (iOS `outputVolume`; Android the
 * music stream, 0 when muted), null when unknown. `headphones`: a wired, USB or (Android) LE-audio
 * headset is an output (iOS a `.headphones` or `.usbAudio` route), null when unknown.
 */
export interface AudioOutputState {
  callActive: boolean;
  volume: number | null;
  headphones: boolean | null;
}

/** The Android DashPal link service as JS asks for it (README §2 `setDashpalLink`). */
export type DashpalLinkState = 'off' | 'waiting' | 'connected';

/**
 * `setDashpalLink(state)`: `running` (started, or a running service updated through its instance),
 * `stopped` (`off`, or nothing was running), `refused` (not started: RoadWise not in front, Nearby
 * devices not granted, or Android refused the start), `unsupported` (iOS).
 */
export type DashpalLinkResult = 'running' | 'stopped' | 'refused' | 'unsupported';

export type CaptureMode = 'mounted' | 'pocket' | 'auto';

/** What JS knows of a drive's end at `stopCapture`, for the forgot-to-start reminder's session. */
export interface CaptureEnd {
  /** When its driving ended, epoch ms (where the car last moved, or the End tap); null when the drive was not kept. */
  drivingEndedAt: number | null;
  /** The car was still at driving speed as the drive ended (it was ended while driving on). */
  drivingAtEnd: boolean;
}
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
   * README §3: Android only, the END of a walking or running transition (EXIT). Live
   * `activity` events only. An exit is never a walk: it clears the walk its ENTER began (the
   * engine's walking end, `src/core/engine/motion.ts`), so an ENTER followed by its EXIT within the
   * 20 s confirmation ends nothing.
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
   * The OS location authorisation. A drive needs While Using only (plan §1 decision 4); the app
   * asks for Always only on iOS, only when the driver turns on the forgot-to-start reminder.
   */
  location: 'none' | 'whenInUse' | 'always';
  motion: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  /**
   * rev1: I11 — iOS: 'unreliable' without a passcode (isProtectedDataAvailable never goes false),
   * 'lagged' with one (~10 s); Android 'reliable'.
   */
  lockSignal: 'reliable' | 'lagged' | 'unreliable';
  /**
   * iOS: this phone has shown a lock reported within 15 s of RoadWise leaving the screen (the lock
   * probe, or an in-drive proof written back with `markLockProof`), so its screen switches can be
   * told from locks. Cleared while there is no passcode. Android: always false (it needs none).
   */
  lockProof: boolean;
  /** iOS: the delay (ms) measured with that proof, null before any. Android: null. */
  lockDelayMs: number | null;
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
 * 3 s, send on change, and re-send an unchanged state every 60 s (the Live Activity's 2-min stale
 * date). `null` speed or limit shows "—". `points` is shown only when non-null
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
  /** The drive is over: Android shows the final notification state; the iOS Live Activity ends at once. */
  ended?: boolean;
  /**
   * The app's sky ("#RRGGBB"), so the background surfaces wear the hour's theme: the driving
   * screen's deepened sky top to bottom, and the sky accent. Null or absent: the plain look.
   */
  skyTop?: string | null;
  skyMid?: string | null;
  skyLow?: string | null;
  accent?: string | null;
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
  /** Android only: a tap on the reminder's note was handed over; read it with `takeReminderTap`. */
  reminderTap: Record<string, never>;
  /**
   * Android only: the DashPal link service's 30-s tick while it waits for the DashPal (JS pumps its
   * timers, so a reconnect back-off fires with JS timers paused). Sent only while a listener is
   * attached; never buffered.
   */
  dashpalLinkTick: Record<string, never>;
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
  'reminderTap',
  'dashpalLinkTick',
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
  'getScreenState',
  'getThermalState',
  'requestMotionPermission',
  'excludeFromBackup',
  'setDriveDisplay',
  'getLastExitInfo',
  'isIgnoringBatteryOptimizations',
  'selfTest',
  'setTripReminder',
  'getTripReminderStatus',
  'requestReminderLocation',
  'claimReminderTap',
  'takeReminderTap',
  'markLockProof',
  'listInstalledApps',
  'launchApp',
  'setDashpalLink',
] as const;

export type DriveSenseMethod = (typeof DRIVE_SENSE_METHODS)[number];

/**
 * The synchronous bridge functions (`Function("<name>")` in both native modules, never
 * `AsyncFunction`): read or done in the same JS turn, because a DashPal ALERT must be answered
 * before the phone plays it (README §2). Never throws natively; the wrapper answers the unknown
 * value where the native module does not exist.
 */
export const DRIVE_SENSE_SYNC_METHODS = ['audioOutputState', 'holdAwake', 'dashpalLinkRunning'] as const;

export type DriveSenseSyncMethod = (typeof DRIVE_SENSE_SYNC_METHODS)[number];

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
  /**
   * Idempotent; clears the persisted capture-open flag. `end`: the drive's end, for the reminder's
   * session (left out: the end is now, nothing more known, as the native watchdog's stop).
   */
  stopCapture(end?: CaptureEnd): Promise<void>;
  /** Ignored (resolves) while not capturing. */
  setCaptureRate(rate: CaptureRate): Promise<void>;
  getState(): Promise<DriveSenseState>;
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
  /**
   * The forgot-to-start reminder's switch (README "Forgot-to-start reminder"). On: saved on even
   * when a permission is missing (the status says what), the session kept, the Android channel
   * created. Off: all of its state forgotten, its feed and wakes stopped, any notification taken
   * down. Never rejects; never starts a capture.
   */
  setTripReminder(enabled: boolean): Promise<TripReminderStatus>;
  /** The reminder's status for Settings, brought up to now first. */
  getTripReminderStatus(): Promise<TripReminderStatus>;
  /**
   * iOS: the one "Always" location request, made only from the driver's tap that turns the reminder
   * on, with While Using already granted; never asked twice. Android: `notNeeded`.
   */
  requestReminderLocation(): Promise<ReminderLocationAnswer>;
  /**
   * A tap on the reminder's note: true once, for the note's own token, while the reminder is on, its
   * session lasts and no drive is open (Android: within 2 min of the tap's hand-over). True spends
   * the token and takes the note down. It never starts a capture: the caller starts the drive.
   */
  claimReminderTap(token: string): Promise<boolean>;
  /**
   * Android: the tap on the reminder's note the phone handed RoadWise, once (null when none is
   * waiting; each token is handed over at most once). iOS: always null (its taps arrive through
   * expo-notifications).
   */
  takeReminderTap(): Promise<ReminderTap | null>;
  /**
   * iOS: an in-drive lock proof (a lock reported `delayMs` after RoadWise left the screen): stored
   * as the phone's proof when `delayMs` is 15 000 or less, so later drives count screen switches
   * from their start. Android: resolves with no effect. Never rejects for a valid argument.
   */
  markLockProof(delayMs: number): Promise<void>;
  /**
   * Android: which of `packages` are installed, enabled and launchable, in the order given, each
   * with the app's own label (only packages the manifest's `<queries>` names are visible). iOS:
   * always `[]` (navigation apps are found by URL scheme in JS). Never rejects for valid arguments.
   */
  listInstalledApps(packages: readonly string[]): Promise<InstalledApp[]>;
  /**
   * Android: opens the app as a launcher tap would (a route in progress is resumed); false when it
   * has no launch intent or the start failed. iOS: always false. Never rejects for a valid argument.
   */
  launchApp(packageName: string): Promise<boolean>;
  /**
   * Sync. What a DashPal alert would play into now (README §2): the call, the media volume and
   * whether headphones are the output. Without the native module: no call, both unknown.
   */
  audioOutputState(): AudioOutputState;
  /**
   * Sync. Android: keeps the CPU awake for `ms` (a partial wake lock, clamped to 1-10 s natively,
   * each call re-arming its timeout) while a DashPal alert is answered and played; true when held.
   * iOS: false, nothing held. The wrapper accepts an integer 1-10 000.
   */
  holdAwake(ms: number): boolean;
  /** Sync. Android: the DashPal link service is running now. iOS: false. */
  dashpalLinkRunning(): boolean;
  /**
   * Android: the DashPal link service (README §2): `off` stops it; a running service takes the new
   * state through its instance (never a second start); a stopped one starts only with RoadWise in
   * front (and Nearby devices granted on Android 14+), else `refused`. iOS: `unsupported`. Never
   * rejects for a valid argument.
   */
  setDashpalLink(state: DashpalLinkState): Promise<DashpalLinkResult>;
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
   * excludeFromBackup, setDriveDisplay, selfTest — the method name, plus `:<arg>` for startCapture,
   * setCaptureRate and excludeFromBackup.
   * Rejected calls are logged too.
   */
  calls: string[];
  /** Read-only calls, in order: getState, getScreenState, getThermalState, getLastExitInfo, isIgnoringBatteryOptimizations. */
  queries: string[];
  setState(s: Partial<DriveSenseState>): void;
  /** JS listeners currently attached for `event` — the watchdog's liveness signal for `row`. */
  listenerCount(event: DriveSenseEvent): number;
  /** What `getLastExitInfo` resolves to (null by default). */
  setLastExitInfo(info: ExitInfo | null): void;
  /** What `isIgnoringBatteryOptimizations` resolves to (default: true on iOS, false on Android). */
  setIgnoringBatteryOptimizations(value: boolean): void;
  /** Every `stopCapture`'s `end`, in order (null when none was given). */
  readonly captureEnds: readonly (CaptureEnd | null)[];
  /** The last `setDriveDisplay` argument delivered while capturing, or null (cleared by stopCapture, as the notification goes). */
  readonly driveDisplay: DriveDisplayState | null;
  /**
   * The phone as the reminder sees it: `available` false = no Play services / motion hardware
   * (`unavailable`); `missing` = what `needs` reports; `location` = what `requestReminderLocation`
   * answers (default: iOS `always`, Android `notNeeded`).
   */
  setTripReminderEnv(env: { available?: boolean; missing?: TripReminderMissing[]; location?: ReminderLocationAnswer }): void;
  /** Android: the apps `listInstalledApps` finds (by package; others are not installed). Default none. */
  setInstalledApps(apps: readonly InstalledApp[]): void;
  /** What `launchApp` answers for an installed app (default true); an app not installed is always false. */
  setLaunchResult(ok: boolean): void;
  /** What `audioOutputState` answers (merged; default no call, volume and headphones unknown). */
  setAudioOutput(s: Partial<AudioOutputState>): void;
  /**
   * Android: whether a stopped DashPal link service may start now (RoadWise in front, Nearby
   * devices granted, Android allowing it); default true. A refused start leaves it stopped.
   */
  setDashpalLinkStartAllowed(allowed: boolean): void;
  /** Android: the DashPal link service's state while it runs, else null (iOS: always null). */
  readonly dashpalLink: DashpalLinkState | null;
  /** Android: the process ends (the service with it); `dashpalLinkRunning()` reads false after. */
  killDashpalLink(): void;
  /** Android: the running service's 30-s tick while `waiting` (emits `dashpalLinkTick` to a listener). Returns whether it ticked. */
  tickDashpalLink(): boolean;
  /** Every `holdAwake(ms)` the fake took, in order (iOS ones included). */
  readonly holdAwakeCalls: number[];
  /** Whether the reminder is switched on now. */
  readonly tripReminderOn: boolean;
  /** A note is up with `token` in a driven, live session, as a stop would have posted it (`now` defaults to the fake's clock). */
  postReminderForTest(token: string, now?: number): void;
  /**
   * Android: a tap on the note with `token` reaches RoadWise, as the module reads it from the
   * intent: handed over once (queued for `takeReminderTap` and announced with `reminderTap`); a
   * token handed over before is dropped. Returns whether it was handed over. iOS: nothing (false).
   */
  tapReminderForTest(token: string): boolean;
  // ——— the native activity feed (README §3) ———
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
