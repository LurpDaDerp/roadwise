// The launch's camera bridge, for the screens that need it (the DMS settings switch asks it for the camera permission,
// the setup screen for a setup session). One per runtime: bootstrap sets it when it builds the drive host and clears
// it when the runtime stops (a handover rebuild sets the new one).
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

/** The camera's status, or null when no camera runs (DMS off, no drive). */
export function useCameraStatus(): DmsHudStatus | null {
  return useSyncExternalStore(subscribe, () => current?.status() ?? null, () => null);
}
