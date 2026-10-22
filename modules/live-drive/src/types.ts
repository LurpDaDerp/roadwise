// The live-drive contract (plan §3.1.3, §3.10): the iOS Live Activity / Dynamic Island that shows the
// drive in progress on the lock screen. iOS 16.2+ only; everywhere else every method is a no-op
// that resolves (`isSupported()`, `isRunning()` and `start()` false, no token) and no event comes.

/** The Live Activity's content (`LiveDriveAttributes.ContentState` in Swift, field for field). */
export interface LiveDriveState {
  /** current speed in `unit`; null shows "-" */
  speed: number | null;
  /** posted limit in `unit`; null shows "-" */
  limit: number | null;
  /** also the sign's style: "mph" the US SPEED LIMIT plate, "km/h" the round red-ringed sign */
  unit: 'mph' | 'km/h';
  /** the driving screen's numeral colour at its speeding tint ("#RRGGBB"); null = white */
  speedTint: string | null;
  /** over the limit now (VoiceOver only) */
  speeding: boolean;
  /** the "Not driving?" hint shows */
  notDrivingAvailable: boolean;
  /** the driving screen's dangerous-weather alert: a `DangerKind` id and its line ("Heavy rain"); null = none */
  weatherKind: string | null;
  weatherText: string | null;
  /** the app's sky, "#RRGGBB" top to bottom: the lock screen's gradient; null or absent: navy */
  skyTop?: string | null;
  skyMid?: string | null;
  skyLow?: string | null;
  /** the sky accent ("#RRGGBB"): the island's keyline; null or absent: gold */
  accent?: string | null;
}

export const LIVE_DRIVE_METHODS = ['isSupported', 'isRunning', 'getPushToStartToken', 'start', 'update', 'end'] as const;

/** Keep identical to `Events(...)` in ios/LiveDriveModule.swift. */
export const LIVE_DRIVE_EVENTS = ['pushToStartToken'] as const;

export type LiveDriveMethod = (typeof LIVE_DRIVE_METHODS)[number];

export type LiveDriveEvents = {
  /** iOS 17.2+: a new push-to-start token, hex. */
  pushToStartToken: { token: string };
};

export type LiveDriveEvent = keyof LiveDriveEvents;

export interface LiveDriveSubscription {
  remove(): void;
}

export interface LiveDriveApi {
  /** iOS 16.2+ with Live Activities enabled for the app in Settings; false elsewhere. */
  isSupported(): Promise<boolean>;
  /** An activity shows the drive now (one started here, adopted, or started by a push). */
  isRunning(): Promise<boolean>;
  /** The push-to-start token (hex, iOS 17.2+) the phone last received, or null. */
  getPushToStartToken(): Promise<string | null>;
  /**
   * Show the drive with `state`: a running activity (a push-started one included) is updated, never
   * replaced; else (none, or one the driver dismissed or iOS ended) one is requested. Resolves whether one is now running (false when unsupported,
   * disabled, or refused by the system, e.g. from the background; the drive goes on regardless).
   */
  start(state: LiveDriveState): Promise<boolean>;
  /**
   * Update the running activity. Without one the state is still kept as the drive's newest (each
   * replaces the one before), and an activity started by a push shows it the moment it is adopted.
   * (`DriveSense.setDriveDisplay` reaches it too, the same way.)
   */
  update(state: LiveDriveState): Promise<void>;
  /** End the running activity at once (a no-op without one) and forget the drive's newest state. Called on drive end or cancel. */
  end(): Promise<void>;
  /** A token payload that is not hex is dropped. Inert without the native module. */
  addListener<E extends LiveDriveEvent>(event: E, fn: (payload: LiveDriveEvents[E]) => void): LiveDriveSubscription;
}

export interface LiveDriveFakeControls {
  /** Whether `isSupported`/`start` succeed (default true). */
  setSupported(supported: boolean): void;
  /** The running activity's state, or null. */
  readonly active: LiveDriveState | null;
  /** An activity started by a push (it runs without `start`): it shows the newest state sent since the last `end`, else `state`. */
  pushStart(state: LiveDriveState): void;
  /** The driver dismissed the activity (or iOS ended it): no longer running; the next `start` requests a new one. */
  dismiss(): void;
  /** What `getPushToStartToken` answers (default null). */
  setToken(token: string | null): void;
  /** A new token arrives: stored and sent to the `pushToStartToken` listeners. */
  emitToken(token: string): void;
  /** Commands in order: `start`, `update`, `end` (plus `isSupported`, `isRunning`, `getPushToStartToken` as queries). */
  calls: string[];
}
