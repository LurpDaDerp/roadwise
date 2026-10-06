/**
 * After a deletion: this phone keeps nothing of the account either. The handover's own wipe
 * (`wipeDevice`: every local table and the drive summaries still scheduled), run straight after
 * the sign-out rather than at the next sign-in.
 */
import { wipeDevice } from '@/boot/device';
import type { Db } from '@/data/db/driver';

export function wipeThisPhone(db: Db): Promise<void> {
  return wipeDevice(db);
}
