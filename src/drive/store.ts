// The React-facing copy of the host's state (zustand, vanilla).
//
// While RoadWise is in front, every host change is published — the HUD needs each row. While it is
// in the background nobody is looking, so only what the root layout's lockout and routing read is
// published: `status`, `lockedOut` and `mode` (final review M6 — a drive that reached speed while
// backgrounded must open locked out, not on the last published `false`). A boolean compare each,
// nothing more on the 1 Hz path. The store catches up with the full snapshot the moment the app is
// active again (rev1: m).
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
      const shown = store.getState();
      if (active || s.status !== shown.status || s.lockedOut !== shown.lockedOut || s.mode !== shown.mode) {
        store.setState(s, true);
      }
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
