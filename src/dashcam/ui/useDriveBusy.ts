// "Is a drive open?" for the DashPal screens, read from the drive context directly: the full drive
// hooks module also loads the weather client, which the onboarding step must not pull in.
import { useCallback, useContext } from 'react';

import { DriveContext } from '@/drive/DriveProvider';

/** A live read of the drive host's busy state; false where no drive host is mounted. */
export function useDriveBusy(): () => boolean {
  const ctx = useContext(DriveContext);
  return useCallback(() => ctx?.host.isBusy() ?? false, [ctx]);
}
