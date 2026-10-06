/**
 * The foreground half of the notification settings (`DeviceHost`'s `onForeground`): when the
 * phone's time zone differs from the one last sent, tell the server, so quiet hours and the Sunday
 * recap follow the driver. One RPC at most per zone change; silent on failure (the next foreground
 * tries again).
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';

import { currentZone, savePrefs } from './api';

export interface SyncPrefsDeps {
  db: Db;
  zone?: () => string;
  save?: (tz: string) => Promise<unknown>;
  onError?: (error: unknown, context: string) => void;
}

export type SyncResult = 'unchanged' | 'saved' | 'error';

export const TZ_SENT_KEY = 'notifications.tzSent';

export async function syncNotificationPrefs(userId: string, deps: SyncPrefsDeps): Promise<SyncResult> {
  const settings = createSettingsRepo(deps.db);
  try {
    const tz = (deps.zone ?? currentZone)();
    const sent = await settings.get<{ uid: string; tz: string }>(TZ_SENT_KEY).catch(() => null);
    if (sent?.uid === userId && sent.tz === tz) return 'unchanged';
    await (deps.save ?? ((zone: string) => savePrefs({}, zone)))(tz);
    await settings.set(TZ_SENT_KEY, { uid: userId, tz });
    return 'saved';
  } catch (error) {
    deps.onError?.(error, 'notification prefs sync');
    return 'error';
  }
}
