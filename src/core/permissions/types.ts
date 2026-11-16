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
   * The phone's own Location Services switch (every app's location). null when it could not be
   * read. iOS reports location `denied` for every app while it is off; Android does not.
   */
  locationServices: boolean | null;
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
  /**
   * What lets the phone wake RoadWise when a drive starts (automatic drives want it), from the drive
   * detector: iOS Background App Refresh; Android's battery usage for RoadWise, `denied` only while
   * it is set to Restricted (Optimized, the default, and Unrestricted are both `available`), and
   * `restricted` while Battery Saver is on with a location mode that stops background fixes (never in
   * the detector's `missing`) (iOS `restricted`: the phone's management turned it off). null where
   * the phone has no drive detector (on Android also one without Google Play services) or it could
   * not be read.
   */
  backgroundRefresh: 'available' | 'denied' | 'restricted' | null;
  /**
   * The Location Always request (Android: "Allow all the time") can still be shown: While Using
   * held, not yet asked (iOS asks once). From the drive detector; null where it has none (Android: or
   * no Google Play services) or unreadable.
   */
  canAskAlways: boolean | null;
  /** The drive's lock-screen surface is allowed: iOS Live Activities, Android the drive notification. null without a detector or unreadable. */
  liveActivities: boolean | null;
  /**
   * Android 11 and later: whether the phone may pause RoadWise and take its permissions back after a
   * few months unopened ("Pause app activity if unused"): `on` (it may), `off`. null (or absent) on
   * iOS, below Android 11, or where it could not be read.
   */
  unusedAppPause?: 'on' | 'off' | null;
  /** epoch ms, integer */
  checkedAt: number;
}

/** The camera, read only (it is asked only when a QR scanner opens). */
export interface CameraAccess {
  access: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

/**
 * The Bluetooth permission alone, never the radio: iOS `granted` with the radio on or off;
 * `undetermined` before the DashPal manager exists (iOS) or while Nearby devices is not granted
 * (Android); `unavailable` with no Bluetooth LE.
 */
export type BluetoothPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

/** The permissions the 14-day prompt policy tracks. */
export type PromptPermission = 'location' | 'motion' | 'notifications';

/** Last OS prompt per permission, epoch ms (settings `permissions.prompts`). */
export type PromptHistory = Partial<Record<PromptPermission, number>>;

/** The slice of the settings repo the policy needs (`createSettingsRepo(db)` satisfies it). */
export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}
