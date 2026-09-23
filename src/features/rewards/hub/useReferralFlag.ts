import { useEffect, useState } from 'react';

import { onAppConfigWritten, readFlag } from '@/data/config/appConfig';
import { useDb } from '@/data/queries';

/**
 * The remote `referral` flag from the cached app config, local default off (R-F: the flag only
 * makes the feature available). A local settings read on mount and after every config write; no
 * timer, no request.
 */
export function useReferralFlag(): boolean {
  const db = useDb();
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => {
      void readFlag(db, 'referral', false).then((v) => {
        if (live) setOn(v);
      });
    };
    read();
    const off = onAppConfigWritten(read);
    return () => {
      live = false;
      off();
    };
  }, [db]);
  return on;
}
