// The React-facing copy of the host's state (zustand, vanilla).
//
// While RoadWise is in front, every host change is published — the driving screen needs each row
// (at most one per second). In front includes `inactive`: Control Center or Notification Center
// pulled over the screen, a call banner, Siri, the app switcher, where the screen still shows and
// must not freeze. While it is in the background nobody is looking, so only what the root layout
// reads is published: `status`, `lockedOut`, the Start card's wait and whether "Not driving?" is
// still offered. The store catches up with the full snapshot the moment the app is in front again.
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { AppStateLike } from '@/data/foreground';

import type { DriveHost, DriveState } from './host';

export type DriveStore = StoreApi<DriveState> & {
  /** Unsubscribe from the host and the app state. Idempotent. */
  dispose(): void;
  /** Subscribe again after `dispose` (React StrictMode re-runs effects), catching up at once. */
  resume(): void;
};

/** On screen: `active`, or `inactive` (an overlay over a screen that still shows); also before the first reading. */
const isActive = (state: string | null | undefined): boolean => state === 'active' || state === 'inactive' || state === 'unknown' || state == null;

export function createDriveStore(host: DriveHost, appState: AppStateLike): DriveStore {
  const store = createStore<DriveState>()(() => host.snapshot());
  let disconnect: (() => void) | null = null;

  function connect(): () => void {
    let active = isActive(appState.currentState);
    const offHost = host.subscribe((s) => {
      const shown = store.getState();
      if (active || s.status !== shown.status || s.lockedOut !== shown.lockedOut || (s.waiting === null) !== (shown.waiting === null) || s.waiting?.phase !== shown.waiting?.phase || s.notDrivingAvailable !== shown.notDrivingAvailable || s.weather?.kind !== shown.weather?.kind) {
        store.setState(s, true);
      }
    });
    const offApp = appState.addEventListener('change', (next) => {
      active = isActive(next);
      if (active) store.setState(host.snapshot(), true);
    });
    return () => {
      offHost();
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
