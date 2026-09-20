/**
 * The other half of `device.ts`: a phone that changes hands **while the app is running**.
 *
 * `ensureDeviceOwner` runs at launch, which covers a handover across a cold start. It does not
 * cover the ordinary one — a parent signs out, a teenager signs in, nobody restarts anything —
 * and until the next launch the new driver is looking at the previous one's drives. The queue
 * cannot post under the wrong account (each item carries its owner uid), but the screen is still
 * somebody else's record, and on a phone shared between a parent and a 16-year-old that is a
 * normal Tuesday rather than an edge case.
 *
 * A wipe cannot be done in place. The live query cache holds the old user's rows, the sync runner
 * may be mid-drain against them, and both were built for the launch that is now over. So this
 * watcher decides nothing more than *whether the device has changed hands* and says so; the host
 * tears the runtime down and builds a new one, whose own `identity` stage does the wiping. One
 * code path empties the device, and it is the one that already has tests.
 */
import type { Db } from '@/data/db';

import { hasDriverData, readDeviceOwner, rememberDeviceOwner } from './device';

/** The slice of the Supabase client this needs. Structural: the real client is assignable. */
export interface AuthWatchable {
  auth: {
    onAuthStateChange(
      listener: (event: string, session: { user: { id: string } } | null) => void
    ): { data: { subscription: { unsubscribe(): void } } };
  };
}

export interface OwnerWatchDeps {
  supabase: AuthWatchable;
  /** The device changed hands. Stop the runtime and bootstrap again; that is what wipes. */
  onHandover: () => void;
  onError?: (error: unknown, context: string) => void;
}

/**
 * Watch for a sign-in by someone other than this device's owner. Returns the unsubscribe.
 *
 * Three things deliberately do **not** raise a handover:
 *   - a **token refresh** or any other event carrying the same uid — it is the same person;
 *   - a **sign-out**. The owner is kept, and their drives keep waiting to upload; signing back in
 *     is `same` and costs nothing. It is the *next* sign-in that decides anything;
 *   - a **first sign-in on a device nobody owned yet _and with nothing on it_**. There is nothing
 *     to wipe and nothing to rebuild, so the owner is simply recorded — which is what makes the
 *     *next* handover, by someone who never relaunched the app, detectable at all. An unowned
 *     device that *does* hold trips or queued work is a different thing entirely and is wiped.
 */
export function watchDeviceOwner(db: Db, deps: OwnerWatchDeps): () => void {
  let live = true;

  const check = async (uid: string | null): Promise<void> => {
    if (uid === null) return;
    const owner = await readDeviceOwner(db);
    if (owner === uid) return;
    // An unowned device is adopted only when it is empty (security review C-1): a database with
    // trips or queued work on it and no owner recorded is a pre-branch device holding somebody
    // else's drives, not a fresh one. Raise the handover and let the rebuild empty it.
    if (owner === null && !(await hasDriverData(db))) {
      await rememberDeviceOwner(db, uid);
      return;
    }
    if (live) deps.onHandover();
  };

  const { data } = deps.supabase.auth.onAuthStateChange((_event, session) => {
    void check(session?.user.id ?? null).catch((error: unknown) => {
      // A settings read that fails must not take the app down, and must not raise a false
      // handover either: the launch check runs again at the next cold start.
      deps.onError?.(error, 'owner watch');
    });
  });

  return () => {
    live = false;
    data.subscription.unsubscribe();
  };
}
