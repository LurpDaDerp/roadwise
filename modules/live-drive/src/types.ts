// The live-drive contract (plan §6): the iOS Live Activity / Dynamic Island that mirrors the
// driving screen while the app is in the background. iOS 16.2+ only; everywhere else every method
// is a no-op that resolves (`isSupported()` false, `start()` false).

/** The Live Activity's content (`LiveDriveAttributes.ContentState` in Swift, field for field). */
export interface LiveDriveState {
  /** current speed in `unit`; null shows "—" */
  speed: number | null;
  /** posted limit in `unit`; null shows "—" */
  limit: number | null;
  unit: 'mph' | 'km/h';
  /** shown only when non-null (the host passes it only while stopped) */
  points: number | null;
  /** change since the last stop; not shown (the host sends null) */
  pointsDelta: number | null;
  /** ≤ 5 mph: the expanded island adds the points line */
  stopped: boolean;
  /** the app's sky, "#RRGGBB" top to bottom: the lock screen's gradient; null or absent: navy */
  skyTop?: string | null;
  skyMid?: string | null;
  skyLow?: string | null;
  /** the sky accent ("#RRGGBB"): the island's keyline; null or absent: gold */
  accent?: string | null;
}

export const LIVE_DRIVE_METHODS = ['isSupported', 'start', 'update', 'end'] as const;

export type LiveDriveMethod = (typeof LIVE_DRIVE_METHODS)[number];

export interface LiveDriveApi {
  /** iOS 16.2+ with Live Activities enabled for the app in Settings; false elsewhere. */
  isSupported(): Promise<boolean>;
  /**
   * Start the activity with `state`. Only ever called by a drive start (plan §6). Ends any activity
   * still running first. Resolves whether an activity is now running (false when unsupported,
   * disabled by the user, or refused by the system — the drive goes on regardless).
   */
  start(state: LiveDriveState): Promise<boolean>;
  /** Update the running activity; a no-op without one. (`DriveSense.setDriveDisplay` reaches it too.) */
  update(state: LiveDriveState): Promise<void>;
  /** End the running activity at once; a no-op without one. Called on drive end or abort. */
  end(): Promise<void>;
}

export interface LiveDriveFakeControls {
  /** Whether `isSupported`/`start` succeed (default true). */
  setSupported(supported: boolean): void;
  /** The running activity's state, or null. */
  readonly active: LiveDriveState | null;
  /** Commands in order: `start`, `update`, `end` (plus `isSupported` as a query). */
  calls: string[];
}
