/**
 * Whose device this is, and what happens when the answer changes.
 *
 * The local database is one file with no user column: it is a cache of *this* driver's record. So
 * the device remembers who it belongs to, and a launch under a different user starts clean:
 *   - **signed out** wipes nothing (drives still wait to upload; the queue defers without a session);
 *   - **first sign-in on an empty device** wipes nothing either: the owner is simply recorded. An
 *     unowned device that *does* hold drives is wiped;
 *   - **a different user** takes everything — every table but the schema's own — before anything
 *     else in the launch touches a row. The install id and the phone's DashPal pairing stay.
 */
import type { DriveDetectApi } from '@drive-sense';

import { activeDashcam } from '@/dashcam/registry';
import { createSettingsRepo, SPOTS_META_KEY, type Db } from '@/data/db';
import { clearDeviceSecret } from '@/data/devices/deviceSecret';
import { emitDataChanged } from '@/data/events';
import { RESTORED_AT_KEY } from '@/data/hydrate/restore';
import { publishUnits } from '@/data/queries/units';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { DROP_NOTICE_KEY } from '@/drive/dropNotice';
import { NOT_DRIVING_KEY } from '@/drive/notDriving';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingTermsKey';
import { DRIVE_SCREEN_ENTERED_KEY } from '@/features/drive/hudPresence';

import { autoDetectOff } from './autoDetect';

/** Where the owner is remembered. The wipe clears it too, and it is rewritten straight after. */
export const LAST_USER_KEY = 'device.lastUserId';

/**
 * A handover the owner watch has seen but no launch has settled yet: the new driver's uid, written
 * durably BEFORE the rebuild is raised. Cleared whenever an owner is decided, and by the wipe.
 */
export const PENDING_OWNER_KEY = 'device.pendingOwner';

/** Every table the wipe empties, children before parents. `schema_version` is the app's, not the driver's. */
export const DEVICE_TABLES: readonly string[] = [
  'trip_events',
  'samples',
  'sync_queue',
  'settings',
  'speed_limit_tiles',
  'dashcam_events',
  'dashcam_boots',
  'dashcam_coverage',
  'problem_spots',
  'trips',
];

/**
 * The one setting the handover wipe keeps: this install's device id (`src/data/devices/installId.ts`).
 * A random id that identifies nothing outside the app; keeping it is what ties every account on one
 * phone to one `device_id` (its push and Live Activity tokens) across a sign-out and sign-in.
 */
export const WIPE_KEEPS_SETTINGS: readonly string[] = ['device.installId'];

/**
 * The phone's DashPal pairing and preferences (`dashcam.*`: the paired dashcam, "Also beep on
 * DashPal", the Bluetooth opt-in, the prompt snoozes) belong to the phone, not to an account: the
 * dashcam holds this phone's bond whoever signs in, so a handover keeps them. Its events, boots and
 * coverage are the driver's and go with the account.
 */
export const WIPE_KEEPS_SETTINGS_PREFIX = 'dashcam.';

/** The driver's own data a plain sign-out removes (the owner key stays, so a return restores from the server). */
export const SIGN_OUT_TABLES: readonly string[] = ['trip_events', 'samples', 'dashcam_events', 'dashcam_boots', 'dashcam_coverage', 'problem_spots', 'trips'];
/**
 * The zones, the notice of a drive that was not kept (`src/drive/dropNotice.ts`), the last drive's
 * "Not driving?" budget, the problem spots' bookkeeping, and the record that this driver's restore
 * ran to the end: their drives just left the phone, so the next sign-in restores them again.
 */
export const SIGN_OUT_SETTINGS: readonly string[] = [
  'privacy.zones',
  DROP_NOTICE_KEY,
  NOT_DRIVING_KEY,
  SPOTS_META_KEY,
  RESTORED_AT_KEY,
  DRIVE_SCREEN_ENTERED_KEY,
];

/** How long a wipe waits for the drive summaries to be cancelled before going on without it. */
export const CANCEL_SUMMARIES_TIMEOUT_MS = 2_000;

/**
 * The DashPal events and boots just left while the app (and a connected dashcam's link) lives on:
 * the link handshakes again, so the boot row comes back and the dashcam replays from the floor.
 * Otherwise the link stays unsynced, and its events unplaced, until the next reconnect.
 */
function restartDashcamLink(): void {
  try {
    activeDashcam()?.restartLink();
  } catch {
    // the wipe stands; the next reconnect handshakes anyway
  }
}

async function cancelSummariesBounded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const { cancelDriveSummaries } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
    await Promise.race([
      // The drive recaps were the leaving driver's.
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
  /** iPhone: the drive detector to disarm and wipe (the launch's); default the registered runtime's. */
  detect?: DriveDetectApi | null;
}

/** Empty the device: every table in `DEVICE_TABLES` in one transaction. */
export async function wipeDevice(db: Db, deps: DeviceOwnerDeps = {}): Promise<void> {
  await cancelSummariesBounded();
  // Automatic drives stop with the account (iPhone): the next driver arms them again. Native's
  // journals, last end and parked spot go too, so none of them reaches the next driver.
  await autoDetectOff({ ...(deps.detect !== undefined ? { detect: deps.detect } : {}), wipe: true });
  // The privacy trim secret goes with the account (a new one is minted on the next drive).
  await clearDeviceSecret();
  await db.transaction(async (tx) => {
    for (const table of DEVICE_TABLES) {
      if (table === 'settings') {
        const keep = WIPE_KEEPS_SETTINGS.map(() => '?').join(', ');
        // `_` and `%` are LIKE wildcards; the prefix has neither, so it matches literally.
        await tx.execute(`DELETE FROM settings WHERE key NOT IN (${keep}) AND key NOT LIKE ?`, [
          ...WIPE_KEEPS_SETTINGS,
          `${WIPE_KEEPS_SETTINGS_PREFIX}%`,
        ]);
      } else {
        await tx.execute(`DELETE FROM ${table}`);
      }
    }
  });
  // Screens still mounted (a deletion's, a sign-up straight after it in the same process) read the
  // empty phone, not the cache of the account that left; the units go back to the default with
  // the setting that held them.
  emitDataChanged({ source: 'wipe' });
  publishUnits('mi');
  restartDashcamLink();
}

/**
 * A plain sign-out with nothing left to upload: the driver's drives (rows, events, samples, their
 * from/to labels and routes) and privacy zones leave the phone now rather than at the next sign-in.
 * The owner record, install id and other settings stay.
 */
export async function wipeForSignOut(db: Db): Promise<void> {
  await cancelSummariesBounded();
  // Signed out, no drive starts on its own (iPhone), and native's journals and parked spot leave with the drives.
  await autoDetectOff({ wipe: true });
  await db.transaction(async (tx) => {
    for (const table of SIGN_OUT_TABLES) await tx.execute(`DELETE FROM ${table}`);
    for (const key of SIGN_OUT_SETTINGS) await tx.execute('DELETE FROM settings WHERE key = ?', [key]);
    // Finished queue items still carry the drives' payloads; what is still owed stays for the next sign-in.
    await tx.execute("DELETE FROM sync_queue WHERE status IN ('done', 'failed')");
  });
  // The cached lists and stats would otherwise show the drives that just left until they went stale.
  emitDataChanged({ source: 'wipe' });
  restartDashcamLink();
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
  if (!adopt) {
    const terms = await incomingTerms(db, uid);
    await wipeDevice(db, deps);
    // The Terms tick the incoming driver just made on the sign-in screen is theirs, not the
    // previous driver's: it outlives the wipe, so the sign-in attestation is still sent for them.
    if (terms !== null) await createSettingsRepo(db).set(PENDING_TERMS_KEY, terms);
  }
  await rememberDeviceOwner(db, uid);
  return adopt ? 'first' : 'wiped';
}

/** The pending Terms tick if it is `uid`'s (bound to them, or still waiting for its sign-in) and unsent. */
async function incomingTerms(db: Db, uid: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await createSettingsRepo(db).get<unknown>(PENDING_TERMS_KEY);
    if (typeof raw !== 'object' || raw === null) return null;
    const tick = raw as Record<string, unknown>;
    if (tick.sent === true) return null;
    return tick.uid === undefined || tick.uid === uid ? tick : null;
  } catch {
    return null;
  }
}
