/**
 * Whose device this is, and what happens when the answer changes.
 *
 * The local database is one file with no user column: it is a cache of *this* driver's record.
 * Nothing in the app has ever cleared it — `signOut` drops the session and leaves every trip,
 * every sample and every queued action exactly where they were. On a shared or handed-down phone
 * that means the next person to sign in inherits the last one's history, and a queued `dispute`
 * or `set-role` written by A would go up under B's token (Task 7's half of this fix refuses such
 * an item at the handler; this half makes sure it is never there to refuse).
 *
 * So the device remembers who it belongs to, and a launch under a different user starts clean.
 * The check is deliberately conservative in both directions:
 *   - **signed out** wipes nothing. A driver who signs out on their own phone still has drives
 *     waiting to upload, and the queue already defers while there is no session;
 *   - **first sign-in ever** wipes nothing either: there is no previous owner, and an install
 *     that recorded drives before its first sign-in must keep them;
 *   - **a different user** takes everything — every table but the schema's own — and every trace
 *     on disk, before anything else in the launch touches a row.
 */
import { createSettingsRepo, type Db } from '@/data/db';

/** Where the owner is remembered. The wipe clears it too, and it is rewritten straight after. */
export const LAST_USER_KEY = 'device.lastUserId';

/**
 * Every table the wipe empties, children before parents so a foreign key never stands in the way.
 *
 * `schema_version` is the only one left alone: the schema is the app's, not the driver's.
 * `speed_limit_tiles` **is** taken, even though limits are public facts about roads — which roads
 * are cached says where the last driver drove, and re-downloading them costs a little data rather
 * than someone's privacy.
 */
export const DEVICE_TABLES: readonly string[] = [
  'trip_events',
  'samples',
  'sync_queue',
  'score_daily_cache',
  'inbox_cache',
  'settings',
  'speed_limit_tiles',
  'trips',
];

/** What the launch found. `wiped` is the only one that destroyed anything. */
export type DeviceOwnerOutcome = 'same' | 'first' | 'wiped' | 'signed-out';

export interface DeviceOwnerDeps {
  /** The traces directory. Left alone when absent, with the failure reported. */
  traces?: { clear(): Promise<void> };
  /** Told about a failure that did not change the outcome. */
  onError?: (error: unknown, context: string) => void;
}

/**
 * Empty the device: every table in `DEVICE_TABLES` in one transaction, then the traces on disk.
 *
 * The rows go first and the files second, on purpose. A crash between the two leaves orphaned
 * trace files, which are unreferenced bytes the next wipe removes; the other order would leave
 * rows pointing at traces that are gone, which the sync runner would carry as real work.
 */
export async function wipeDevice(db: Db, deps: DeviceOwnerDeps = {}): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of DEVICE_TABLES) await tx.execute(`DELETE FROM ${table}`);
  });
  try {
    await deps.traces?.clear();
  } catch (error) {
    // The rows are already gone, which is what the queue and every screen read. A trace file the
    // filesystem would not part with is bytes on disk, not somebody's drive in somebody's account.
    deps.onError?.(error, 'wipe traces');
  }
}

/** Who this device belongs to, or null if nobody has signed in on it yet. */
export const readDeviceOwner = (db: Db): Promise<string | null> =>
  createSettingsRepo(db).get<string>(LAST_USER_KEY);

/** Record the owner without touching anything else. */
export const rememberDeviceOwner = (db: Db, uid: string): Promise<void> =>
  createSettingsRepo(db).set(LAST_USER_KEY, uid);

/**
 * Compare the signed-in user against the one this device remembers, wiping if they differ, and
 * record the new owner. Call before anything reads a row — at launch that is straight after
 * `migrate` and before recovery, so a previous owner's interrupted drive is never finalized into
 * the new owner's account.
 */
export async function ensureDeviceOwner(
  db: Db,
  uid: string | null,
  deps: DeviceOwnerDeps = {}
): Promise<DeviceOwnerOutcome> {
  if (uid === null) return 'signed-out';

  const lastUserId = await readDeviceOwner(db);
  if (lastUserId === uid) return 'same';

  if (lastUserId !== null) await wipeDevice(db, deps);
  await rememberDeviceOwner(db, uid);
  return lastUserId === null ? 'first' : 'wiped';
}
