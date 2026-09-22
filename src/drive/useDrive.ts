// The hooks screens read the drive through.
import { useContext } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { DriveContext, type DriveContextValue } from './DriveProvider';
import type { DriveHost, DriveState } from './host';

function useDriveContext(): DriveContextValue {
  const value = useContext(DriveContext);
  if (value === null) throw new Error('useDrive must be used inside <DriveProvider>');
  return value;
}

/**
 * A slice of the drive state. The selector's result is compared shallowly (rev1: m), so an object
 * selector — `useDrive((s) => ({ status: s.status, lockedOut: s.lockedOut }))` — re-renders only
 * when one of its fields changes, not on every 1 Hz row.
 */
export function useDrive<T>(selector: (s: DriveState) => T): T {
  const { store } = useDriveContext();
  return useStore(store, useShallow(selector));
}

/** The host itself, for actions (start, end, mutes, passenger). */
export function useDriveHost(): DriveHost {
  return useDriveContext().host;
}
