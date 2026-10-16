// What the drive host needs from drive-sense: start and stop the capture, one state read, and the
// event subscription. `createFakeDriveSense()` satisfies it in tests.
import DriveSense, { type DriveSenseApi } from '@drive-sense';

export type DriveSource = Pick<DriveSenseApi, 'startCapture' | 'stopCapture' | 'getState' | 'addListener'> &
  /** iOS: an in-drive lock proof written back, so later drives count screen switches from their start. */
  Partial<Pick<DriveSenseApi, 'markLockProof'>>;

/** The native module (every method rejects where it is absent: Jest, Expo Go, web). */
export const nativeDriveSource: DriveSource = DriveSense;

/**
 * What the DashPal runtime needs from drive-sense: the audio output probe, the alert wake lock and
 * the Android DashPal link service (and its tick). `createFakeDriveSense()` satisfies it in tests.
 */
export type DashpalNative = Pick<DriveSenseApi, 'audioOutputState' | 'holdAwake' | 'dashpalLinkRunning' | 'setDashpalLink' | 'addListener'>;

/** The native module (the sync reads answer "unknown" where it is absent; the async call rejects). */
export const nativeDashpal: DashpalNative = DriveSense;
