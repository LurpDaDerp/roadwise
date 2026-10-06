// What the drive host needs from drive-sense: start and stop the capture, one state read, and the
// event subscription. `createFakeDriveSense()` satisfies it in tests.
import DriveSense, { type DriveSenseApi } from '@drive-sense';

export type DriveSource = Pick<DriveSenseApi, 'startCapture' | 'stopCapture' | 'getState' | 'addListener' | 'setForgotToStartReminder'>;

/** The native module (every method rejects where it is absent: Jest, Expo Go, web). */
export const nativeDriveSource: DriveSource = DriveSense;
