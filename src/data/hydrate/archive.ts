/**
 * The phone's half of the 183-day rule (`@/data/db/archive`): run at every launch, just after the
 * migration, and once a day while the app is in front. Cheap when there is nothing to do (two
 * counts), and idempotent. A drive under way keeps the database to itself: the job does nothing
 * then and says so (null), so the next launch or foreground does it.
 *
 * The archive's transaction runs with `secure_delete` on, so the bytes it frees (the routes, places
 * and labels) are overwritten with zeros rather than left in the file's free space. The pragma is
 * per connection and the device driver gives each transaction its own, so it is set on the
 * transaction's handle and put back as it was before the transaction ends.
 */
import { archiveDue, countDue, isRecording } from '@/data/db/archive';
import type { Db } from '@/data/db/driver';
import { asNumber } from '@/data/db/row';
import { emitDataChanged } from '@/data/events';

/** The connection's `secure_delete`: off (0), or on (1; any other answer reads as on, so it is left alone). */
async function secureDelete(on: Db): Promise<number> {
  const { rows } = await on.execute('PRAGMA secure_delete');
  try {
    return asNumber(rows[0] ?? {}, 'secure_delete') === 0 ? 0 : 1;
  } catch {
    return 1;
  }
}

/** Archive the drives due at `now`: how many were archived, or null when a drive is recording. */
export async function archiveOldDrives(db: Db, now: number): Promise<number | null> {
  if (await isRecording(db, now)) return null;
  if ((await countDue(db, now)) === 0) return 0;
  const archived = await db.transaction(async (tx) => {
    const before = await secureDelete(tx);
    await tx.execute('PRAGMA secure_delete = ON');
    try {
      return await archiveDue(tx, now);
    } finally {
      if (before === 0) await tx.execute('PRAGMA secure_delete = OFF');
    }
  });
  // The lists drop the drives and the map takes their routes from the pool. Nothing was queued, so
  // the change reads as a hydration: the screens refresh and the sync runner stays asleep.
  if (archived > 0) emitDataChanged({ source: 'hydrate' });
  return archived;
}
