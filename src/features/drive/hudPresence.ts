// Whether the driving screen is the one the driver is looking at, and whether it has been shown
// during a given drive. The driving screen reports itself (focused with RoadWise in front); the
// recap notifier reads it to decide whether a drive's end needs a notification, and the lockout
// reads it so an automatic drive locks the app to the driving screen only once it was opened.
// The drive it was last shown for is also written to device storage (the launch binds the writer,
// `bindDriveScreenMemory`), so a relaunch in the middle of that drive keeps it entered
// (`markDriveScreenEntered`, from the launch once the host has taken the drive in).

/** Settings key: the drive the driving screen was last shown for. One id; a later drive replaces it. */
export const DRIVE_SCREEN_ENTERED_KEY = 'drive.screenEntered';

let focused = false;
const entered = new Set<string>();
const listeners = new Set<(focused: boolean) => void>();
let remember: ((tripId: string) => void) | null = null;

/** The driving screen gained or lost focus (with RoadWise in front) during the drive `tripId`. */
export function setDriveScreenFocused(next: boolean, tripId: string | null): void {
  if (next && tripId !== null && !entered.has(tripId)) {
    entered.add(tripId);
    remember?.(tripId);
  }
  if (next === focused) return;
  focused = next;
  for (const fn of [...listeners]) fn(focused);
}

/** True while the driving screen is focused with RoadWise in front. */
export function isDriveScreenFocused(): boolean {
  return focused;
}

/** True once the driving screen has been focused during the drive `tripId`. */
export function driveScreenEnteredFor(tripId: string | null): boolean {
  return tripId !== null && entered.has(tripId);
}

/**
 * The drive `tripId` was entered before this process (read back from device storage at a relaunch
 * mid-drive): it counts as entered, and listeners re-read. Nothing is written.
 */
export function markDriveScreenEntered(tripId: string): void {
  if (entered.has(tripId)) return;
  entered.add(tripId);
  for (const fn of [...listeners]) fn(focused);
}

/**
 * Where the first entry of each drive is written (the launch's settings), or null for nowhere.
 * Returns the unbind, which leaves a later binding in place.
 */
export function bindDriveScreenMemory(write: ((tripId: string) => void) | null): () => void {
  remember = write;
  return () => {
    if (remember === write) remember = null;
  };
}

/** Calls `fn` whenever the driving screen's focus changes (or a drive is marked entered); returns the unsubscribe. */
export function subscribeDriveScreen(fn: (focused: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only: back to a fresh launch. */
export function resetDriveScreenPresence(): void {
  focused = false;
  entered.clear();
  listeners.clear();
  remember = null;
}
