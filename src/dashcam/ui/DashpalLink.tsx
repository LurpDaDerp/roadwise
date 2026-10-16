import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useDriveHost } from '@/drive/useDrive';

import { isDashcamId } from '../protocol';
import { PENDING_SETUP_KEY, setupHref } from './links';

/**
 * `/dashpal[?d=<dashcam id>]`: a DashPal link (the label's QR code read by the phone's own camera;
 * `+native-intent` already moved its code into SecureStore). Opens the setup on that DashPal's Pair
 * screen, or, while a drive is open, holds the link (`PENDING_SETUP_KEY`: `{at, dashcamId}`, never
 * the code) and goes Home; the prompt host replays it once the drive is over.
 */
export function DashpalLink({ d, now = Date.now }: { d?: string | null; now?: () => number }) {
  const router = useRouter();
  const host = useDriveHost();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const dashcamId = typeof d === 'string' && isDashcamId(d.toLowerCase()) ? d.toLowerCase() : null;

  useEffect(() => {
    let live = true;
    void (async () => {
      if (host.isBusy()) {
        await settings.set(PENDING_SETUP_KEY, { at: now(), dashcamId }).catch(() => {});
        if (live) router.replace('/');
        return;
      }
      if (live) router.replace(setupHref({ link: dashcamId }));
    })();
    return () => {
      live = false;
    };
  }, [host, settings, router, now, dashcamId]);

  return null;
}
