// What the drive host needs from drive-sense: start and stop the capture, one state read, the
// event subscription, and the one-time reminder retirement. `createFakeDriveSense()` satisfies it in
// tests. On iOS the host also drives the drive detector (`DriveDetect`, `nativeDriveDetect`).
import DriveSense, { DriveDetect, type DriveDetectApi, type DriveSenseApi } from '@drive-sense';

export type DriveSource = Pick<DriveSenseApi, 'startCapture' | 'stopCapture' | 'getState' | 'addListener'> &
  /** The forgot-to-start reminder's switch: the bootstrap turns it off once per install (it is retired). */
  Partial<Pick<DriveSenseApi, 'setTripReminder'>>;

/** The native module (every method rejects where it is absent: Jest, Expo Go, web). */
export const nativeDriveSource: DriveSource = DriveSense;

/** The iOS drive detector, or null where it does not exist (Android, Jest, Expo Go, web). */
export const nativeDriveDetect = (): DriveDetectApi | null => (DriveDetect.available ? DriveDetect : null);

/**
 * What the DashPal runtime needs from drive-sense: the audio output probe, the alert wake lock and
 * the Android DashPal link service (and its tick). `createFakeDriveSense()` satisfies it in tests.
 */
export type DashpalNative = Pick<DriveSenseApi, 'audioOutputState' | 'holdAwake' | 'dashpalLinkRunning' | 'setDashpalLink' | 'addListener'>;

/** The native module (the sync reads answer "unknown" where it is absent; the async call rejects). */
export const nativeDashpal: DashpalNative = DriveSense;
