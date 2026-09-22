// Puts one drive host and its store in React context (H2 mounts it in the root layout).
import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { DriveHost } from './host';
import { createDriveStore, type DriveStore } from './store';

export interface DriveContextValue {
  host: DriveHost;
  store: DriveStore;
}

export const DriveContext = createContext<DriveContextValue | null>(null);

export function DriveProvider(props: { host: DriveHost; children: ReactNode }) {
  const { host, children } = props;
  // A new host (a rebuilt runtime after a handover) gets a new store; the old one is let go.
  const value = useMemo<DriveContextValue>(
    () => ({ host, store: createDriveStore(host, AppState) }),
    [host]
  );
  useEffect(() => {
    value.store.resume();
    return () => value.store.dispose();
  }, [value]);
  return <DriveContext.Provider value={value}>{children}</DriveContext.Provider>;
}
