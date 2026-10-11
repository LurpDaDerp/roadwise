import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useDriveHost } from '@/drive/useDrive';

import { PENDING_SETUP_KEY, setupHref } from './links';

/**
 * `roadwise://dashpal` (the QR code in the DashPal box): opens the setup, or — while a drive is open —
 * holds the request (`PENDING_SETUP_KEY`) and goes Home; the prompt host replays it once the drive
 * is over (the notifications' precedent, `src/features/notifications/responses.ts`).
 */
export function DashpalLink({ now = Date.now }: { now?: () => number }) {
  const router = useRouter();
  const host = useDriveHost();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);

  useEffect(() => {
    let live = true;
    void (async () => {
      if (host.isBusy()) {
        await settings.set(PENDING_SETUP_KEY, { at: now() }).catch(() => {});
        if (live) router.replace('/');
        return;
      }
      if (live) router.replace(setupHref());
    })();
    return () => {
      live = false;
    };
  }, [host, settings, router, now]);

  return null;
}
