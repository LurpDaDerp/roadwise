/**
 * The one line Home shows under the drive card that no stored state holds: why a Start drive swipe
 * started nothing (the same refusal the button shows), or that a drive stopped from "Not driving?"
 * won't count. A tiny process-local store (written by the start path and the driving screen, read by
 * Home with `useSyncExternalStore`), so the line shows whether Home is already on screen or opens
 * after. Nothing is written to the phone: it never outlives the app's process. A refusal stands
 * until the next start or sign-out; the "Not driving?" line until OK, the next start or sign-out.
 * It carries words only: it starts nothing and reaches nothing of the drive.
 */
import { useSyncExternalStore } from 'react';

import type { StartRefusal } from './StartDrive';

export type HomeNotice = StartRefusal | 'notDriving';

let current: HomeNotice | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of [...listeners]) fn();
};

export function showHomeNotice(n: HomeNotice): void {
  current = n;
  emit();
}

/** The driver started a drive, said OK, or signed out: the notice is spent. */
export function clearHomeNotice(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function readHomeNotice(): HomeNotice | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useHomeNotice(): HomeNotice | null {
  return useSyncExternalStore(subscribe, readHomeNotice, readHomeNotice);
}
