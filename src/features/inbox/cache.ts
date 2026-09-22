/**
 * The phone's copy of the inbox, over the existing `inbox_cache` table (no schema change), and the
 * read/dismiss decisions the server has not heard yet.
 *
 * - **One row per inbox id.** `payload_json` holds the whole validated server row (the granted
 *   columns), so the cache answers exactly what the last fetch did; `read_at` mirrors the row's
 *   `read_at` in epoch ms. A dismissal is recorded inside the row (`dismissed_at`), not by deleting
 *   it: the cap count needs every row pushed today, dismissed or not.
 * - **Pending sets** (`inbox.pendingRead` / `inbox.pendingDismiss`, settings, ≤ 500 newest) hold
 *   ids marked on the phone and not yet confirmed by the server. They are flushed before every
 *   fetch and re-applied after it, so a tap made offline, or while a fetch was in flight, is never
 *   undone by a stale reply.
 * - The handover wipe empties both `inbox_cache` and `settings`, so nothing here outlives the
 *   account that owns it.
 */
import type { Db } from '@/data/db/driver';
import { asText } from '@/data/db/row';
import { createSettingsRepo } from '@/data/db/settings';
import { OPENED_TRIPS_KEY } from '@/notifications/keys';

import { errorCode, InboxRowSchema, type InboxApi, type InboxRow } from './api';

export const PENDING_READ_KEY = 'inbox.pendingRead';
export const PENDING_DISMISS_KEY = 'inbox.pendingDismiss';
/** At most this many ids wait per set; the oldest go first (the server has them long since). */
export const PENDING_MAX = 500;
/** `list` returns at most this many rows. */
export const CACHE_LIST_MAX = 200;

export type PendingKind = 'read' | 'dismiss';

const PENDING_KEY: Record<PendingKind, string> = {
  read: PENDING_READ_KEY,
  dismiss: PENDING_DISMISS_KEY,
};

function parseRow(json: string): InboxRow | null {
  try {
    const parsed = InboxRowSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const newestFirst = (a: InboxRow, b: InboxRow): number => {
  const d = Date.parse(b.created_at) - Date.parse(a.created_at);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const epochOrNull = (value: string | null): number | null =>
  value === null ? null : Date.parse(value);

export function createInboxCache(db: Db) {
  const settings = createSettingsRepo(db);

  async function readPending(kind: PendingKind): Promise<string[]> {
    const value = await settings.get<unknown>(PENDING_KEY[kind]);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  }

  /** Rewrite rows by id with `edit`; returns how many changed. */
  async function editRows(ids: readonly string[], edit: (row: InboxRow) => InboxRow | null): Promise<number> {
    if (ids.length === 0) return 0;
    const wanted = new Set(ids);
    return db.transaction(async (tx) => {
      const { rows } = await tx.execute('SELECT id, payload_json FROM inbox_cache');
      let changed = 0;
      for (const raw of rows) {
        const id = asText(raw, 'id');
        if (!wanted.has(id)) continue;
        const row = parseRow(asText(raw, 'payload_json'));
        if (row === null) continue;
        const next = edit(row);
        if (next === null) continue;
        await tx.execute('UPDATE inbox_cache SET payload_json = ?, read_at = ? WHERE id = ?', [
          JSON.stringify(next),
          epochOrNull(next.read_at),
          id,
        ]);
        changed += 1;
      }
      return changed;
    });
  }

  return {
    /** The cache becomes exactly `rows`. */
    async replaceAll(rows: readonly InboxRow[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute('DELETE FROM inbox_cache');
        for (const row of rows) {
          await tx.execute(
            'INSERT OR REPLACE INTO inbox_cache (id, payload_json, read_at) VALUES (?, ?, ?)',
            [row.id, JSON.stringify(row), epochOrNull(row.read_at)]
          );
        }
      });
    },

    /** Newest first, at most `limit` (≤ 200). Sorted here: `created_at` lives inside the JSON. */
    async list(limit: number = CACHE_LIST_MAX): Promise<InboxRow[]> {
      const { rows } = await db.execute('SELECT payload_json FROM inbox_cache');
      const out: InboxRow[] = [];
      for (const raw of rows) {
        const row = parseRow(asText(raw, 'payload_json'));
        if (row !== null) out.push(row);
      }
      return out.sort(newestFirst).slice(0, Math.min(limit, CACHE_LIST_MAX));
    },

    /** Stamp `read_at = at` on the rows that are still unread. */
    markReadLocal: (ids: readonly string[], at: string) =>
      editRows(ids, (row) => (row.read_at === null ? { ...row, read_at: at } : null)),

    /** Stamp `dismissed_at = at` on the rows not yet dismissed. */
    dismissLocal: (ids: readonly string[], at: string) =>
      editRows(ids, (row) => (row.dismissed_at === null ? { ...row, dismissed_at: at } : null)),

    readPending,

    async addPending(kind: PendingKind, ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      const current = await readPending(kind);
      const merged = [...current.filter((id) => !ids.includes(id)), ...new Set(ids)];
      await settings.set(PENDING_KEY[kind], merged.slice(-PENDING_MAX));
    },

    async removePending(kind: PendingKind, ids: readonly string[]): Promise<void> {
      const gone = new Set(ids);
      const current = await readPending(kind);
      const kept = current.filter((id) => !gone.has(id));
      if (kept.length === current.length) return;
      await settings.set(PENDING_KEY[kind], kept);
    },
  };
}

export type InboxCache = ReturnType<typeof createInboxCache>;

/**
 * Mark rows read on the phone now and queue them for the server. The next flush (before the next
 * fetch, or straight after a tap) sends them. Exported for the notification tap's `data.inboxId`.
 */
export async function queueInboxRead(db: Db, ids: readonly string[], now: number): Promise<void> {
  const cache = createInboxCache(db);
  await cache.markReadLocal(ids, new Date(now).toISOString());
  await cache.addPending('read', ids);
}

/** Dismiss rows on the phone now and queue them for the server. */
export async function queueInboxDismiss(db: Db, ids: readonly string[], now: number): Promise<void> {
  const cache = createInboxCache(db);
  await cache.dismissLocal(ids, new Date(now).toISOString());
  await cache.addPending('dismiss', ids);
}

/**
 * Send both pending sets. Ids are removed only once the server has answered for them, so an id
 * queued while this runs stays for the next flush. A batch the server refuses as malformed
 * (`22023`: not an inbox id) is dropped — retrying it can never succeed. Any other failure (no
 * connection, no session) is rethrown with the set intact.
 */
export async function flushPending(db: Db, api: InboxApi): Promise<void> {
  const cache = createInboxCache(db);
  for (const kind of ['read', 'dismiss'] as const) {
    const ids = await cache.readPending(kind);
    if (ids.length === 0) continue;
    try {
      if (kind === 'read') await api.markInboxRead(ids);
      else await api.dismissInbox(ids);
    } catch (error) {
      if (errorCode(error) !== '22023') throw error;
    }
    await cache.removePending(kind, ids);
  }
}

/** Put the phone's pending decisions back over rows a fetch just wrote. */
export async function reapplyPending(db: Db, now: number): Promise<void> {
  const cache = createInboxCache(db);
  const at = new Date(now).toISOString();
  await cache.markReadLocal(await cache.readPending('read'), at);
  await cache.dismissLocal(await cache.readPending('dismiss'), at);
}

/** The drive a `trip_summary` row is about, or null. */
export function clientTripIdOf(row: InboxRow): string | null {
  const id = row.payload.clientTripId;
  return row.type === 'trip_summary' && typeof id === 'string' ? id : null;
}

/**
 * The driver already opened these drives' summaries from their notification (`OPENED_TRIPS_KEY`,
 * written by the notification tap): their inbox rows are read. Each unread match is marked and
 * queued; every matched trip id is cleared from the key, and an id with no row yet (its row is not
 * due) stays until one arrives.
 */
export async function applyOpenedTrips(db: Db, rows: readonly InboxRow[], now: number): Promise<void> {
  const settings = createSettingsRepo(db);
  const stored = await settings.get<unknown>(OPENED_TRIPS_KEY);
  const opened = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  if (opened.length === 0) return;
  const openedSet = new Set(opened);
  const matchedTrips = new Set<string>();
  const unread: string[] = [];
  for (const row of rows) {
    const trip = clientTripIdOf(row);
    if (trip === null || !openedSet.has(trip)) continue;
    matchedTrips.add(trip);
    if (row.read_at === null) unread.push(row.id);
  }
  if (matchedTrips.size === 0) return;
  await queueInboxRead(db, unread, now);
  // Re-read before writing: the notification tap may have added a trip meanwhile.
  const latest = await settings.get<unknown>(OPENED_TRIPS_KEY);
  const current = Array.isArray(latest) ? latest.filter((id): id is string => typeof id === 'string') : [];
  await settings.set(
    OPENED_TRIPS_KEY,
    current.filter((id) => !matchedTrips.has(id))
  );
}
