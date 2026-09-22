// What the drive host needs from drive-sense (N1): the commands, the two reads it makes, and the
// event subscription. Narrow on purpose, so the host cannot reach for anything that would run while
// armed and idle (§3.5) — no polling reads such as the thermal or screen state; those arrive as
// events while capturing. `createFakeDriveSense()` satisfies it in tests and the parked simulation.
import DriveSense, { type DriveSenseApi } from '@drive-sense';

export type DriveSource = Pick<
  DriveSenseApi,
  | 'arm'
  | 'disarm'
  | 'startCapture'
  | 'stopCapture'
  | 'setCaptureRate'
  | 'getState'
  | 'queryMotionHistory'
  | 'setNotificationState'
  | 'addListener'
>;

/** The native module (every method rejects where it is absent: Jest, Expo Go, web). */
export const nativeDriveSource: DriveSource = DriveSense;
