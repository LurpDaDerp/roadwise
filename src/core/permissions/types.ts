// The permission-health vocabulary (M4 Task 8, product B2, design §5.3). Pure types: no module
// here touches the OS. `adapters.ts` turns the phone's answers into a `PermissionSnapshot`;
// `health.ts` turns a snapshot plus the driver's own choices into a `HealthReport`.

export type PermissionPlatform = 'ios' | 'android';

/** Location as the app can use it: `foreground` is While Using (or Android foreground-only). */
export type LocationAccess = 'always' | 'foreground' | 'denied' | 'undetermined';

/** Motion / activity recognition, as drive-sense reports it (`unavailable`: no hardware or module). */
export type Grant = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type NotificationAccess = 'granted' | 'provisional' | 'denied' | 'undetermined';

/** Android battery optimisation for this app; `unknown` when it cannot be read from here. */
export type BatteryOptimization = 'exempt' | 'optimized' | 'unknown';

export interface PermissionSnapshot {
  platform: PermissionPlatform;
  location: LocationAccess;
  /** Precise (iOS full accuracy / Android fine) location; null while location is not granted. */
  precise: boolean | null;
  /**
   * Whether the OS can still show the prompt for the NEXT step up: the foreground prompt while
   * location is `denied`/`undetermined`, the background (Always) prompt while it is `foreground`.
   * False means only Settings can change it (e.g. iOS after "Keep Only While Using").
   */
  locationCanAskAgain: boolean;
  /**
   * null = could not be checked (drive-sense absent or its read failed) — "can't check", never
   * reported as `unavailable` (a statement about the device) and left out of the server report.
   */
  motion: Grant | null;
  notifications: NotificationAccess;
  notificationsCanAskAgain: boolean;
  batteryOptimization: BatteryOptimization;
  /** iOS Low Power Mode / Android Battery Saver; null when it could not be read. */
  lowPowerMode: boolean | null;
  /** epoch ms, integer */
  checkedAt: number;
}

export type HealthRowId =
  | 'location'
  | 'precise'
  | 'locationAlways'
  | 'autoRecord'
  | 'motion'
  | 'notifications'
  | 'battery'
  | 'lowPower';

/**
 * `ok` granted / working; `off` explicitly turned off; `attention` degraded or not yet asked;
 * `info` nothing to fix (a choice, not available yet, cannot be checked, informational).
 */
export type HealthStatus = 'ok' | 'attention' | 'off' | 'info';

export type FixAction = 'request' | 'openSettings' | 'openBatterySettings' | 'none';

/**
 * `choice`: the driver chose manual (A9 Skip, Always declined, or auto-record turned off);
 * `notAvailable`: the server has withdrawn auto-record (the `auto_detect` flag) — nothing to fix;
 * `afterFirstDrive`: iOS Always is offered only after the first completed drive;
 * `lapsed`: previously granted, now lost; `cantCheck`: the state could not be read.
 */
export type HealthReason =
  | 'choice'
  | 'notAvailable'
  | 'afterFirstDrive'
  | 'lapsed'
  | 'cantCheck'
  /**
   * Auto-record is wanted and the phone allows it, but this account has not affirmed the
   * background-location disclosure (Task 19 r1): the host will not arm. Fixable — never a choice.
   */
  | 'notAffirmed';

export interface HealthRow {
  id: HealthRowId;
  status: HealthStatus;
  fix: FixAction;
  reason?: HealthReason;
}

export type RecordingMode = 'automatic' | 'manual' | 'unavailable';

export interface HealthReport {
  overall: 'ok' | 'attention' | 'broken';
  rows: HealthRow[];
  recordingMode: RecordingMode;
  showBanner: boolean;
}

/** Permissions whose loss from a granted state is a lapse (settings `permissions.everGranted`). */
export type EverGrantedKey = 'location' | 'locationAlways' | 'motion';
export type EverGranted = Partial<Record<EverGrantedKey, boolean>>;

export interface HealthContext {
  /** A driver (not a non-driver account). Non-drivers get no driving rows at all. */
  drives: boolean;
  /** The driver's own auto-record choice: `host.autoDetectEnabled()`, never `status === 'off'`. */
  autoDetectOn: boolean;
  /**
   * Whether the server makes auto-record available (the `auto_detect` flag). Optional, default
   * true: with the flag withdrawn, recording is never reported as automatic.
   */
  autoDetectAvailable?: boolean;
  firstDriveDone: boolean;
  /** A9 Skip, or Always declined in the disclosure or the OS (settings `permissions.manualByChoice`). */
  manualByChoice: boolean;
  everGranted: EverGranted;
  /**
   * This account has affirmed the background-location disclosure (at or above the arming minimum).
   * The host arms only then (Task 19 r1). Optional, default true: only the app's hook knows it.
   */
  disclosureAffirmed?: boolean;
}

/** The permissions the 14-day prompt policy tracks. */
export type PromptPermission = 'location' | 'locationAlways' | 'motion' | 'notifications';

/** Last OS prompt per permission, epoch ms (settings `permissions.prompts`). */
export type PromptHistory = Partial<Record<PromptPermission, number>>;

/** The slice of the settings repo the policy needs (`createSettingsRepo(db)` satisfies it). */
export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export type ReportedFrom = 'foreground' | 'background';

/** What the phone reports in `devices.permissions` (the lapse trigger reads it). */
export interface ServerPermissions {
  v: 1;
  location: LocationAccess;
  precise: boolean | null;
  /** Absent when motion could not be checked (the lapse trigger reads a missing key as unknown). */
  motion?: Grant;
  notifications: NotificationAccess;
  batteryOptimization: BatteryOptimization;
  reportedFrom: ReportedFrom;
  /** True when the change was observed on return from B2's own Open Settings (no lapse item). */
  ack: boolean;
  /**
   * Losing Always is excused now: auto-record off by the driver's choice (manual mode), or withdrawn
   * by the server (`auto_detect` off) — `isAlwaysExcused`, the health model's own excuse (final
   * review I4). 0007's lapse trigger raises no `location_always` lapse while it is true. Absent in a
   * report written before it existed: read as false.
   */
  alwaysExcused?: boolean;
  /** ISO 8601 */
  checkedAt: string;
}
