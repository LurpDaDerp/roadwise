// RoadWise leaving the screen during a drive (product spec v3 "Screen switches").
//
// - The navigation button is the one way out that is never a screen switch: it tells the drive host
//   through this sink (`noteLeaving`) before it opens the navigation app, and takes it back
//   (`cancelLeaving`) when the app did not open. The host stamps the rows until RoadWise is back.
// - Every other way RoadWise itself would open something outside the app (a Settings page, a
//   browser page that leaves the app, the store, a share sheet and the data export) is refused while
//   a drive records: one dialog says "End the drive first" (`blockedDuringDrive`). Outside a drive
//   nothing changes.
//
// The sink is the drive host, registered by the bootstrap beside it; with none (no host yet, or
// tests) nothing is noted and nothing is blocked.
import { Alert } from 'react-native';

export interface LeaveSink {
  /** The navigation button is opening the navigation app (only while recording). */
  beginLeave(): void;
  /** That app did not open: the rows are no longer excused. */
  cancelLeave(): void;
  /** A drive is recording. */
  recording(): boolean;
}

export const leaveCopy = {
  title: 'End the drive first',
  body: 'This opens outside RoadWise. Leaving during a drive counts as phone use.',
  ok: 'OK',
} as const;

let sink: LeaveSink | null = null;

export function setLeaveSink(next: LeaveSink | null): void {
  sink = next;
}

/** The navigation button is about to open the navigation app. */
export function noteLeaving(): void {
  try {
    sink?.beginLeave();
  } catch {
    // the host's own failure: the navigation app still opens
  }
}

/** The navigation app did not open. */
export function cancelLeaving(): void {
  try {
    sink?.cancelLeave();
  } catch {
    // nothing to take back
  }
}

/** A drive is recording now. False with no host. */
export function driveRecording(): boolean {
  try {
    return sink?.recording() ?? false;
  } catch {
    return false;
  }
}

/**
 * True, after showing "End the drive first", when a drive is recording: the caller must not open
 * what it was about to open. False (and nothing shown) otherwise.
 */
export function blockedDuringDrive(): boolean {
  if (!driveRecording()) return false;
  Alert.alert(leaveCopy.title, leaveCopy.body, [{ text: leaveCopy.ok }]);
  return true;
}
