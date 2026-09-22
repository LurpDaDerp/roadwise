/**
 * Whether this phone tells the server when it is driving: true only while a drive-state source is
 * registered — the runtime's reporter (bootstrap, ruling T10 (4)) (rev1: C1). A8's promise "We hold them while you're
 * driving." is shown only when this is true, so the screen never claims what the app does not do.
 */
import { useSyncExternalStore } from 'react';

let sources = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of [...listeners]) listener();
};

export const isDriveStateReported = (): boolean => sources > 0;

/** Marks a drive-state source as present. Returns its release, which is safe to call twice. */
export function registerDriveStateSource(): () => void {
  sources += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sources -= 1;
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDriveStateReported(): boolean {
  return useSyncExternalStore(subscribe, isDriveStateReported, isDriveStateReported);
}
