/**
 * The phone's half of the 183-day rule (`@/data/db/archive`): run at every launch, just after the
 * migration, and once a day while the app is in front. Cheap when there is nothing to do (two
 * counts), and idempotent. A drive under way keeps the database to itself: the job does nothing
 * then and says so (null), so the next launch or foreground does it.
 */
import { archiveDue, countDue, isRecording } from '@/data/db/archive';
import type { Db } from '@/data/db/driver';
import { emitDataChanged } from '@/data/events';

/** Archive the drives due at `now`: how many were archived, or null when a drive is recording. */
export async function archiveOldDrives(db: Db, now: number): Promise<number | null> {
  if (await isRecording(db)) return null;
  if ((await countDue(db, now)) === 0) return 0;
  const archived = await db.transaction((tx) => archiveDue(tx, now));
  // The lists drop the drives and the map takes their routes from the pool. Nothing was queued, so
  // the change reads as a hydration: the screens refresh and the sync runner stays asleep.
  if (archived > 0) emitDataChanged({ source: 'hydrate' });
  return archived;
}
