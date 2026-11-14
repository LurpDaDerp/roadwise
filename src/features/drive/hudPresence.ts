// Whether the driving screen is the one the driver is looking at. The driving screen reports itself
// (focused with RoadWise in front); the recap notifier reads it to decide whether a drive's end
// needs a notification.

let focused = false;
const listeners = new Set<(focused: boolean) => void>();

/** The driving screen gained or lost focus (with RoadWise in front). */
export function setDriveScreenFocused(next: boolean): void {
  if (next === focused) return;
  focused = next;
  for (const fn of [...listeners]) fn(focused);
}

/** True while the driving screen is focused with RoadWise in front. */
export function isDriveScreenFocused(): boolean {
  return focused;
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
  listeners.clear();
}
