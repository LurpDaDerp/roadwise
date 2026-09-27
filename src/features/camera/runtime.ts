// The launch's camera bridge, for the screens that show its state (the HUD chip). One per runtime: bootstrap sets it
// when it builds the drive host and clears it when the runtime stops (a handover rebuild sets the new one).
import { useSyncExternalStore } from 'react';

import type { DmsHudStatus } from '@/core/dms';

import type { CameraBridge } from './bridge';

let current: CameraBridge | null = null;
const listeners = new Set<() => void>();
let off: (() => void) | null = null;

function changed(): void {
  for (const l of [...listeners]) l();
}

export function setCameraBridge(bridge: CameraBridge | null): void {
  off?.();
  off = null;
  current = bridge;
  if (bridge !== null) off = bridge.subscribeStatus(changed);
  changed();
}

export function cameraBridge(): CameraBridge | null {
  return current;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The camera's HUD status, or null when no camera runs (not opted in, no drive, or the beta off for it). */
export function useCameraStatus(): DmsHudStatus | null {
  return useSyncExternalStore(subscribe, () => current?.status() ?? null, () => null);
}
