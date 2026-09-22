/**
 * Where a restore from the server has got to, for the screens that must not say something the
 * device does not yet know (R9: during a restore the score slot says "Restoring…", never
 * "Building your score" — which would be false for an experienced driver on a new phone).
 *
 * A tiny external store rather than a query: the hydrator is not React, and the state has to
 * reach a screen the moment it changes, not at the next refetch. Only **full** runs (a first
 * sign-in, a wiped device, a device that was never restored) move it; the six-hourly incremental
 * top-up is silent, because it cannot turn a known history into an unknown one.
 *
 * - `idle` — nothing is being restored, or the last restore finished.
 * - `restoring` — a full restore is owed or running; `restored` counts the trips written so far.
 * - `failed` — the last full restore stopped before the end (offline, an error). It is retried at
 *   the next foreground; until it completes the device's history is still incomplete.
 */
import { useSyncExternalStore } from 'react';

export type HydrationStatus =
  | { state: 'idle' }
  | { state: 'restoring'; restored: number }
  | { state: 'failed'; at: number };

const IDLE: HydrationStatus = { state: 'idle' };

let current: HydrationStatus = IDLE;
const listeners = new Set<() => void>();

export function getHydrationStatus(): HydrationStatus {
  return current;
}

/** For the hydrator and the foreground wiring only. Listeners hear only a real change. */
export function setHydrationStatus(next: HydrationStatus): void {
  const same =
    next.state === current.state &&
    (next.state !== 'restoring' || (current.state === 'restoring' && current.restored === next.restored)) &&
    (next.state !== 'failed' || (current.state === 'failed' && current.at === next.at));
  if (same) return;
  current = next.state === 'idle' ? IDLE : next;
  for (const listener of [...listeners]) listener();
}

export function subscribeHydrationStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The restore state, re-rendering the caller whenever it changes. */
export function useHydrationStatus(): HydrationStatus {
  return useSyncExternalStore(subscribeHydrationStatus, getHydrationStatus, getHydrationStatus);
}
