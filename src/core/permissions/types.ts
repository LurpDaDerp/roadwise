// The permission vocabulary. Pure types: no module here touches the OS. `adapters.ts` turns the
// phone's answers into a `PermissionSnapshot`; `src/features/permissions/health.ts` turns a snapshot
// into the rows the permission screens show.

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

/** The permissions the 14-day prompt policy tracks. */
export type PromptPermission = 'location' | 'motion' | 'notifications';

/** Last OS prompt per permission, epoch ms (settings `permissions.prompts`). */
export type PromptHistory = Partial<Record<PromptPermission, number>>;

/** The slice of the settings repo the policy needs (`createSettingsRepo(db)` satisfies it). */
export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}
