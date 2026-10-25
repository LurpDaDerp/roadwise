// DEMO ONLY (temporary): hooks the screens read the demo through.
import { useMemo } from 'react';

import { demoDashpalOf, useDemo, type DemoDashpal } from './demoStore';

/** The DashPal alert the cycle shows now (one object per alert, so a render never restarts a banner), or null. */
export function useDemoDashpal(): DemoDashpal | null {
  const s = useDemo();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key fields name the alert; the rest of the state does not change it
  return useMemo(() => demoDashpalOf(s), [s.dashpalCycle, s.dashpalIndex, s.dashpalAt, s.dashpalCount]);
}
