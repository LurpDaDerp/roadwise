/**
 * Whose device this is, and what happens when the answer changes.
 *
 * The local database is one file with no user column: it is a cache of *this* driver's record. So
 * the device remembers who it belongs to, and a launch under a different user starts clean:
 *   - **signed out** wipes nothing (drives still wait to upload; the queue defers without a session);
 *   - **first sign-in on an empty device** wipes nothing either: the owner is simply recorded. An
 *     unowned device that *does* hold drives is wiped;
 *   - **a different user** takes everything — every table but the schema's own — before anything
 *     else in the launch touches a row.
 */
import { createSettingsRepo, type Db } from '@/data/db';
import { clearDeviceSecret } from '@/data/devices/deviceSecret';
import { SESSION_UID_KEY } from '@/data/sync/queue';

/** Where the owner is remembered. The wipe clears it too, and it is rewritten straight after. */
export const LAST_USER_KEY = 'device.lastUserId';

/**
 * A handover the owner watch has seen but no launch has settled yet: the new driver's uid, written
 * durably BEFORE the rebuild is raised. Cleared whenever an owner is decided, and by the wipe.
 */
export const PENDING_OWNER_KEY = 'device.pendingOwner';

/** Every table the wipe empties, children before parents. `schema_version` is the app's, not the driver's. */
export const DEVICE_TABLES: readonly string[] = ['trip_events', 'samples', 'sync_queue', 'settings', 'speed_limit_tiles', 'trips'];

/**
 * The one setting the handover wipe keeps: this install's device id (`src/data/devices/installId.ts`).
 * A random id that identifies nothing outside the app; keeping it is what ties every account on one
 * phone to one `device_id`, so "one league-eligible account per device" holds across a sign-out and
 * sign-in (security audit, Important 3).
 */
export const WIPE_KEEPS_SETTINGS: readonly string[] = ['device.installId'];

/** The driver's own data a plain sign-out removes (the owner key stays, so a return restores from the server). */
export const SIGN_OUT_TABLES: readonly string[] = ['trip_events', 'samples', 'trips'];
export const SIGN_OUT_SETTINGS: readonly string[] = ['privacy.zones', 'reminder.forgottenCheckedAt'];

/** How long a wipe waits for the drive summaries to be cancelled before going on without it. */
export const CANCEL_SUMMARIES_TIMEOUT_MS = 2_000;

async function cancelSummariesBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const { cancelDriveSummaries } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
    await Promise.race([
      cancelDriveSummaries().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CANCEL_SUMMARIES_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // No notifications module: nothing is scheduled that could fire.
  } finally {
    clearTimeout(timer);
  }
}

/** What the launch found. `wiped` is the only one that destroyed anything. */
export type DeviceOwnerOutcome = 'same' | 'first' | 'wiped' | 'signed-out';

export interface DeviceOwnerDeps {
  onError?: (error: unknown, context: string) => void;
}

/** Empty the device: every table in `DEVICE_TABLES` in one transaction. */
export async function wipeDevice(db: Db, _deps: DeviceOwnerDeps = {}): Promise<void> {
  await cancelSummariesBounded();
  // The privacy trim secret goes with the account (a new one is minted on the next drive).
  await clearDeviceSecret();
  await db.transaction(async (tx) => {
    for (const table of DEVICE_TABLES) {
      if (table === 'settings') {
        const keep = WIPE_KEEPS_SETTINGS.map(() => '?').join(', ');
        await tx.execute(`DELETE FROM settings WHERE key NOT IN (${keep})`, [...WIPE_KEEPS_SETTINGS]);
      } else {
        await tx.execute(`DELETE FROM ${table}`);
      }
    }
  });
}

/**
 * A plain sign-out with nothing left to upload: the driver's drives (rows, events, samples, their
 * from/to labels and routes) and privacy zones leave the phone now rather than at the next sign-in.
 * The owner record, install id and other settings stay.
 */
export async function wipeForSignOut(db: Db): Promise<void> {
  await cancelSummariesBounded();
  await db.transaction(async (tx) => {
    for (const table of SIGN_OUT_TABLES) await tx.execute(`DELETE FROM ${table}`);
    for (const key of SIGN_OUT_SETTINGS) await tx.execute('DELETE FROM settings WHERE key = ?', [key]);
    // Finished queue items still carry the drives' payloads; what is still owed stays for the next sign-in.
    await tx.execute("DELETE FROM sync_queue WHERE status IN ('done', 'failed')");
  });
}

/** Who this device belongs to, or null if nobody has signed in on it yet. */
export const readDeviceOwner = (db: Db): Promise<string | null> => createSettingsRepo(db).get<string>(LAST_USER_KEY);

/** Whether anything on this device belongs to a driver: a trip, or work owed to the server. */
export async function hasDriverData(db: Db): Promise<boolean> {
  const { rows } = await db.execute('SELECT (SELECT COUNT(*) FROM trips) + (SELECT COUNT(*) FROM sync_queue) AS n');
  return Number((rows[0] as Record<string, unknown>).n) > 0;
}

/** Record the owner, in both places that answer "whose work is this?". */
export async function rememberDeviceOwner(db: Db, uid: string): Promise<void> {
  const settings = createSettingsRepo(db);
  await settings.set(LAST_USER_KEY, uid);
  await settings.set(SESSION_UID_KEY, uid);
  await settings.remove(PENDING_OWNER_KEY);
}

/**
 * Compare the signed-in user against the one this device remembers, wiping if they differ, and
 * record the new owner. Call before anything reads a row.
 */
export async function ensureDeviceOwner(db: Db, uid: string | null, deps: DeviceOwnerDeps = {}): Promise<DeviceOwnerOutcome> {
  if (uid === null) return 'signed-out';
  const lastUserId = await readDeviceOwner(db);
  if (lastUserId === uid) {
    await rememberDeviceOwner(db, uid);
    return 'same';
  }
  const adopt = lastUserId === null && !(await hasDriverData(db));
  if (!adopt) await wipeDevice(db, deps);
  await rememberDeviceOwner(db, uid);
  return adopt ? 'first' : 'wiped';
}
