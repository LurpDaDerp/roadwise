import { useEffect } from 'react';

/**
 * Screens whose contents must never be copied into an image (the DashPal aiming picture, which is
 * kept in memory only). While any is up, the theme takes no snapshot of the app for its fade, and the
 * new sky lands at once instead. Pair it with `usePreventScreenCapture` on such a screen.
 */
const blockers = new Set<string>();

export const snapshotBlocked = (): boolean => blockers.size > 0;

export function useSnapshotBlocked(key: string): void {
  useEffect(() => {
    blockers.add(key);
    return () => {
      blockers.delete(key);
    };
  }, [key]);
}
