import { useContext, useSyncExternalStore } from 'react';

import { DriveContext } from '@/drive/DriveProvider';

const noSubscription = () => () => {};
const never = () => false;

/**
 * True while the driving lockout is on (SR2, design §3.4): a driver's trip is recording above the
 * lockout speed. Screens that present an RN `Modal` — which renders natively above the lockout
 * overlay, out of its reach — close it while this is true (rev1: I12).
 *
 * Safe outside `<DriveProvider>` (screens rendered on their own, tests, the moments before the drive
 * runtime is up): with no drive there is no lockout, so it answers false. It subscribes to the one
 * boolean, so the 1 Hz rows never re-render the caller.
 */
export function useLockout(): boolean {
  const store = useContext(DriveContext)?.store;
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getState().lockedOut : never
  );
}
