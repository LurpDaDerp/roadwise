import type { Db } from '@/data/db/driver';

/**
 * The drives this device has deleted, by client id, kept for the life of the install (security
 * review D1 M-2).
 *
 * The `delete:<id>` queue item already says "this drive was deleted here", but a settled item is
 * purged within a day, and a delete can settle while the server still holds the drive (a finalize
 * that timed out on the device and landed on the server after the delete's `not_found`). A restore
 * that meets the drive after that must neither write it back nor stay silent: it re-sends the
 * delete. So the ids are kept here, one short string each, and never purged.
 *
 * Stored in `settings`, which the handover wipe empties — correctly: the next owner's restore has
 * nothing to do with this owner's deletes.
 */
export const TOMBSTONES_KEY = 'trips.deletedIds';

/** Every client id this device has deleted, read on `on` so a check and a write can share it. */
export async function readTombstones(on: Db): Promise<Set<string>> {
  const { rows } = await on.execute('SELECT value_json FROM settings WHERE key = ?', [TOMBSTONES_KEY]);
  const raw = rows[0]?.value_json;
  if (typeof raw !== 'string') return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remember a deleted drive. Idempotent; runs on `on`, so it commits with the delete itself. */
export async function addTombstone(on: Db, clientTripId: string): Promise<void> {
  const ids = await readTombstones(on);
  if (ids.has(clientTripId)) return;
  ids.add(clientTripId);
  await on.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
    TOMBSTONES_KEY,
    JSON.stringify([...ids]),
  ]);
}
