/**
 * Why a tap on the forgot-to-start reminder did not start a drive, for Home to say: the same
 * refusal the Start Drive button shows, or that the reminder has expired. A tiny process-local store
 * (set by the notification-tap handler, read by Home with `useSyncExternalStore`), so the line
 * shows whether Home is already on screen or opens after the tap. It carries words only: it starts
 * nothing, reaches nothing of the drive, and is not a link parameter.
 */
import { useSyncExternalStore } from 'react';

import type { StartRefusal } from './StartDrive';

export type StartNotice = StartRefusal | 'reminder-expired';

let current: StartNotice | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of [...listeners]) fn();
};

export function showStartNotice(n: StartNotice): void {
  current = n;
  emit();
}

/** Home took the notice into its own banner (or the driver started a drive): it is spent. */
export function clearStartNotice(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function readStartNotice(): StartNotice | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useStartNotice(): StartNotice | null {
  return useSyncExternalStore(subscribe, readStartNotice, readStartNotice);
}
