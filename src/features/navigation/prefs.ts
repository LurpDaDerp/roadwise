// The driver's default navigation app: one device setting, a catalogue id. An id this build does
// not know reads as unset. It lives in SQLite with the other device settings, so it survives a
// restart; a reinstall (or the device wipe when another account signs in) clears it.
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';

import { navAppById, type NavAppId } from './catalog';

export const NAV_APP_KEY = 'navigation.app';

export async function readNavApp(db: Db): Promise<NavAppId | null> {
  try {
    return navAppById(await createSettingsRepo(db).get<unknown>(NAV_APP_KEY))?.id ?? null;
  } catch {
    return null;
  }
}

export async function writeNavApp(db: Db, id: NavAppId): Promise<void> {
  await createSettingsRepo(db).set(NAV_APP_KEY, id);
}

export async function clearNavApp(db: Db): Promise<void> {
  await createSettingsRepo(db).remove(NAV_APP_KEY);
}
