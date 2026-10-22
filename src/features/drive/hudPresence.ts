// Whether the driving screen is the one the driver is looking at, and whether it has been shown
// during a given drive. The driving screen reports itself (focused with RoadWise in front); the
// recap notifier reads it to decide whether a drive's end needs a notification, and the lockout
// reads it so an automatic drive locks the app to the driving screen only once it was opened.

let focused = false;
const entered = new Set<string>();
const listeners = new Set<(focused: boolean) => void>();

/** The driving screen gained or lost focus (with RoadWise in front) during the drive `tripId`. */
export function setDriveScreenFocused(next: boolean, tripId: string | null): void {
  if (next && tripId !== null) entered.add(tripId);
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

/** Calls `fn` whenever the driving screen's focus changes; returns the unsubscribe. */
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
}
