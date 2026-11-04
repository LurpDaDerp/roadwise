/**
 * The foreground half of the notification settings (`DeviceHost`'s `onForeground`): when the
 * phone's time zone differs from the one last sent, tell the server, so quiet hours and the Sunday
 * recap follow the driver. One RPC at most per zone change; silent on failure (the next foreground
 * tries again). The server's answer refreshes this phone's copy of the quiet hours (`quietHours.ts`);
 * with no copy yet (a driver who set quiet hours before this phone kept one), the prefs are read
 * once to make it. A copy that changes plans the weather heads-ups again.
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { requestCommuteReplanLazily } from '@/features/weather/cancelHeadsUps';

import { currentZone, readPrefs, savePrefs } from './api';
import { hasQuietHours, quietOfAnswer, rememberQuietHours } from './quietHours';

export interface SyncPrefsDeps {
  db: Db;
  zone?: () => string;
  save?: (tz: string) => Promise<unknown>;
  /** The prefs as the server holds them (read when the phone has no copy of the quiet hours). */
  read?: () => Promise<unknown>;
  /** The phone's copy of the quiet hours changed. Default: plan the weather heads-ups again. */
  onQuietHours?: () => void;
  onError?: (error: unknown, context: string) => void;
}

export type SyncResult = 'unchanged' | 'saved' | 'error';

export const TZ_SENT_KEY = 'notifications.tzSent';

export async function syncNotificationPrefs(userId: string, deps: SyncPrefsDeps): Promise<SyncResult> {
  const settings = createSettingsRepo(deps.db);
  const remember = async (answer: unknown) => {
    const quiet = quietOfAnswer(answer);
    if (quiet && (await rememberQuietHours(settings, quiet).catch(() => false))) (deps.onQuietHours ?? requestCommuteReplanLazily)();
  };
  try {
    const tz = (deps.zone ?? currentZone)();
    const sent = await settings.get<{ uid: string; tz: string }>(TZ_SENT_KEY).catch(() => null);
    if (sent?.uid === userId && sent.tz === tz) {
      // No copy of the quiet hours yet: read them once.
      if (!(await hasQuietHours(settings).catch(() => true))) await remember(await (deps.read ?? readPrefs)());
      return 'unchanged';
    }
    const answer = await (deps.save ?? ((zone: string) => savePrefs({}, zone)))(tz);
    await settings.set(TZ_SENT_KEY, { uid: userId, tz });
    // The answer carries the quiet hours too: the phone's copy follows them.
    await remember(answer);
    return 'saved';
  } catch (error) {
    deps.onError?.(error, 'notification prefs sync');
    return 'error';
  }
}
