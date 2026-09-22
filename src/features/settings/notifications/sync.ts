/**
 * The foreground half of H6's server state, run by `DeviceHost`'s `onForeground` (Task 18 mounts
 * it): tell the server this phone's zone and its count of notifications shown today, and refresh
 * the cached effective preferences the local notifier reads offline.
 *
 * - **One write, only those columns.** `tz` when the phone's zone differs from the row's, and
 *   `local_sent_day`/`local_sent_count` when today's count differs from what the row holds for today
 *   (a zero count needs no write over another day: the server already reads that as 0). Never a
 *   quiet-hours field or a category, so null fields keep following `notification_defaults`
 *   (rev1: m). Update, then insert when there is no row (no upsert: 42501 on `user_id`).
 * - **Silent.** Every failure resolves `'error'` and goes to `onError`; it never throws.
 * - **Battery (§3.5).** It runs only when the app comes to the front: one read, at most one write.
 */
import { normaliseZone } from '@/core/engine/finalize';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import {
  effectivePrefs,
  readLocalSent,
  writePrefsCache,
  type NotificationDefaults,
} from '@/notifications/localDelivery';

import { currentZone, readPrefs, savePrefs, type PrefsClient, type PrefsPatch, type PrefsRow } from './api';

export interface SyncPrefsDeps {
  db: Db;
  /** Default: the app's Supabase client. */
  client?: PrefsClient;
  /** Default: the phone's zone. Normalised either way. */
  zone?: () => string;
  now?: () => number;
  /** Default: the cached app config's `notification_defaults`. */
  defaults?: () => Promise<NotificationDefaults>;
  onError?: (error: unknown, context: string) => void;
}

export type SyncResult = 'unchanged' | 'saved' | 'error';

/** The columns (tz and today's count) that differ between the phone and the row. */
function patchFor(row: PrefsRow | null, tz: string, local: { day: string; count: number }): PrefsPatch {
  const patch: PrefsPatch = {};
  if (row?.tz !== tz) patch.tz = tz;
  const count = Math.min(Math.max(local.count, 0), 50); // the column's CHECK
  const differs =
    row !== null && row.local_sent_day === local.day ? row.local_sent_count !== count : count > 0;
  if (differs) {
    patch.local_sent_day = local.day;
    patch.local_sent_count = count;
  }
  return patch;
}

async function defaultDefaults(db: Db): Promise<NotificationDefaults> {
  const { readConfig } = await import('@/data/config/appConfig');
  return (await readConfig(db)).notification_defaults;
}

export async function syncNotificationPrefs(userId: string, deps: SyncPrefsDeps): Promise<SyncResult> {
  const onError = deps.onError ?? (() => {});
  const now = (deps.now ?? Date.now)();
  const tz = normaliseZone((deps.zone ?? currentZone)());
  const settings = createSettingsRepo(deps.db);
  let row: PrefsRow | null = null;
  let read = false;
  try {
    const local = await readLocalSent(settings, tz, now);
    const client = deps.client ?? (await import('@/data/supabase/client')).supabase;
    row = await readPrefs(userId, client);
    read = true;
    const patch = patchFor(row, tz, local);
    const wrote = Object.keys(patch).length > 0;
    if (wrote) row = await savePrefs(userId, patch, client);
    await cache();
    return wrote ? 'saved' : 'unchanged';
  } catch (error) {
    onError(error, 'notification prefs sync');
    if (read) await cache().catch(() => undefined);
    return 'error';
  }

  async function cache(): Promise<void> {
    const defaults = await (deps.defaults ?? (() => defaultDefaults(deps.db)))();
    await writePrefsCache(settings, effectivePrefs(row, defaults));
  }
}
