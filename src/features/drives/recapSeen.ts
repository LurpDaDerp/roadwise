// Which recaps the driver has opened (product spec "Notifications"): the recap notification's
// "I wasn't driving" asks its confirm only while the drive's recap was never opened, so the choice
// is always made before the score is seen. The drive screen marks its drive here as it shows it.
// One settings key holding the most recent trip ids, newest first; no table.
import { createSettingsRepo, type Db } from '@/data/db';

/** Settings key: the trip ids whose recap was opened, newest first. */
export const RECAP_SEEN_KEY = 'drives.recapSeen';
/** At most this many ids are kept: far more drives than fit in the notification's 30 minutes. */
export const RECAP_SEEN_MAX = 50;

/** The stored ids, or none when the key is absent or not a list of ids. */
function parseSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** The recap of `clientTripId` was opened. Idempotent; the oldest id goes past `RECAP_SEEN_MAX`. */
export async function markRecapSeen(db: Db, clientTripId: string): Promise<void> {
  if (clientTripId.length === 0) return;
  const settings = createSettingsRepo(db);
  const seen = parseSeen(await settings.get<unknown>(RECAP_SEEN_KEY));
  if (seen[0] === clientTripId) return;
  const next = [clientTripId, ...seen.filter((id) => id !== clientTripId)].slice(0, RECAP_SEEN_MAX);
  await settings.set(RECAP_SEEN_KEY, next);
}

/** Whether the recap of `clientTripId` was ever opened on this phone. */
export async function wasRecapSeen(db: Db, clientTripId: string): Promise<boolean> {
  return parseSeen(await createSettingsRepo(db).get<unknown>(RECAP_SEEN_KEY)).includes(clientTripId);
}
