// The React-facing copy of the host's state (zustand, vanilla).
//
// While RoadWise is in front, every host change is published — the HUD needs each row. While it is
// in the background nobody is looking, so only status changes are published (the root layout's
// lockout and routing need those); the host's own state keeps updating, and the store catches up
// with the latest snapshot the moment the app is active again (rev1: m).
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { AppStateLike } from '@/data/foreground';

import type { DriveHost, DriveState } from './host';

export type DriveStore = StoreApi<DriveState> & {
  /** Unsubscribe from the host and the app state. Idempotent. */
  dispose(): void;
  /** Subscribe again after `dispose` (React StrictMode re-runs effects), catching up at once. */
  resume(): void;
};

/**
 * `active` in front. Before React Native knows (`unknown`, or no value at all) the store errs toward
 * publishing: an extra update costs a render, a missing one would leave the HUD stale.
 */
const isActive = (state: string | null | undefined): boolean =>
  state === 'active' || state === 'unknown' || state == null;

export function createDriveStore(host: DriveHost, appState: AppStateLike): DriveStore {
  const store = createStore<DriveState>()(() => host.snapshot());
  let disconnect: (() => void) | null = null;

  function connect(): () => void {
    let active = isActive(appState.currentState);
    const offHost = host.subscribe((s) => {
      if (active || s.status !== store.getState().status) store.setState(s, true);
    });
    const offApp = appState.addEventListener('change', (next) => {
      active = isActive(next);
      if (active) store.setState(host.snapshot(), true);
    });
    return () => {
      offHost();
      // Jest's react-native mock returns no subscription; a device always does.
      offApp?.remove();
    };
  }

  disconnect = connect();
  return Object.assign(store, {
    dispose() {
      const off = disconnect;
      disconnect = null;
      off?.();
    },
    resume() {
      if (disconnect !== null) return;
      disconnect = connect();
      if (store.getState() !== host.snapshot()) store.setState(host.snapshot(), true);
    },
  });
}
