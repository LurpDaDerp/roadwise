/**
 * This install's device id: the `devices.id` the server keys this phone by, under the signed-in
 * account (`primary key (user_id, id)`).
 *
 * It lives in `settings`, so the handover wipe (`src/boot/device.ts`) takes it with everything
 * else: a phone that changes hands comes back as a new device, never as the last owner's row.
 * Random, never derived from hardware, so it identifies nothing outside this app.
 */
import type { SettingsRepo } from '@/data/db/settings';
import { newClientTripId } from '@/lib/ids';

export const INSTALL_ID_KEY = 'device.installId';

/** What a stored id must look like to be sent (the column allows 128 characters). */
const VALID_ID = /^[A-Za-z0-9_-]{8,128}$/;

type Settings = Pick<SettingsRepo, 'get' | 'set'>;

/** The stored install id, or null when there is none yet (or it is unusable). Never creates one. */
export async function readInstallId(settings: Pick<SettingsRepo, 'get'>): Promise<string | null> {
  const stored = await settings.get<unknown>(INSTALL_ID_KEY);
  return typeof stored === 'string' && VALID_ID.test(stored) ? stored : null;
}

/** One at a time, so two first calls cannot mint two ids. */
let lock: Promise<unknown> = Promise.resolve();

/** The install id, made and stored on first use (and again after a wipe). */
export function getInstallId(settings: Settings, newId: () => string = newClientTripId): Promise<string> {
  const run = lock.then(async () => {
    const stored = await readInstallId(settings);
    if (stored !== null) return stored;
    const id = newId();
    await settings.set(INSTALL_ID_KEY, id);
    return id;
  });
  lock = run.catch(() => {});
  return run;
}
