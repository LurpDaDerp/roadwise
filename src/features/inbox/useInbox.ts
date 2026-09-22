/**
 * B3's data hooks.
 *
 * **Freshness without polling (design §3.5).** The inbox query is fetched when a screen that shows
 * it mounts and its data is older than `staleTime` (5 minutes), when the app comes to the
 * foreground with stale data, when the connection comes back after an offline answer, and when a
 * notification arrives (the notification host invalidates `INBOX_QUERY_KEY`). Nothing runs on a
 * timer, and nothing runs while the app is in the background.
 *
 * **Offline.** With no connection — or when the request cannot reach the server — the answer is
 * the phone's cache with `offline: true`; the screen says so. A server that answered with a
 * refusal is an error, which the screen shows with a retry.
 *
 * **Read and dismiss** are written to the phone first (so the tap is never lost), queued, and sent
 * straight away when online; whatever cannot be sent now goes before the next fetch.
 *
 * The key is `[...INBOX_QUERY_KEY, uid]`: the notification host's invalidation of `['inbox']`
 * still reaches it (prefix match), and one account's rows can never be served to the next.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { readInstallId } from '@/data/devices/installId';
import { readAlwaysExcused } from '@/data/devices/permissionsReport';
import { deviceZone } from '@/lib/deviceZone';
import type { AppStateLike } from '@/data/foreground';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { readTombstones } from '@/data/db/tombstones';
import { toEventRow } from '@/data/db/events';
import { toTripRow } from '@/data/db/trips';
import { getSharedOnline } from '@/data/net/net';
import { useOnline } from '@/data/net/useOnline';
import { toTripEventView, useDataSource, type TripEventView } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { renderInboxBase, type NotificationType } from '@/notifications/catalog';
import { INBOX_QUERY_KEY } from '@/notifications/keys';

import { defaultInboxApi, InboxOfflineError, type InboxApi, type InboxRow } from './api';
import {
  applyOpenedTrips,
  clientTripIdOf,
  createInboxCache,
  flushPending,
  queueInboxDismiss,
  queueInboxRead,
  reapplyPending,
} from './cache';
import {
  isVisibleRow,
  toItemView,
  toTripDetail,
  type InboxItemView,
  type InboxLocal,
  type PermissionsNow,
} from './viewModel';

/** How long a fetched inbox is served before a mount or a foreground fetches again. */
export const INBOX_STALE_MS = 5 * 60_000;

/** The server rows, newest first (dismissed included), and whether they came from the cache offline. */
export interface InboxSnapshot {
  rows: InboxRow[];
  offline: boolean;
}

export interface InboxDeps {
  api?: InboxApi;
  appState?: AppStateLike;
  /** Where a lapse row's current state is read (T8's adapter by default). */
  permissions?: Pick<PermissionsAdapter, 'snapshot'>;
}

/** The query that holds this phone's permissions for the lapse rows (a local OS read, no network). */
export const PERMISSIONS_NOW_KEY = ['inbox-permissions-now'] as const;

/**
 * This install's id and its permissions now. Each half is null when it cannot be read — the row
 * then says nothing about now (ruling T6 (1)). Never rejects.
 */
export async function readPermissionsNow(
  db: Db,
  adapter: Pick<PermissionsAdapter, 'snapshot'>
): Promise<PermissionsNow> {
  const [deviceId, snapshot] = await Promise.all([
    readInstallId(createSettingsRepo(db)).catch(() => null),
    adapter.snapshot().catch(() => null),
  ]);
  // The report's own excuse (final review I4), so the row and the server agree on "not a fault".
  const alwaysExcused = snapshot === null ? null : await readAlwaysExcused(db, snapshot);
  return { deviceId, snapshot, alwaysExcused };
}

export const inboxKey = (uid: string) => [...INBOX_QUERY_KEY, uid] as const;

// ---------------------------------------------------------------------------------------------
// The load (pure over a Db and an api, so it is tested without React)
// ---------------------------------------------------------------------------------------------

const isOffline = (error: unknown): boolean => error instanceof InboxOfflineError;

/**
 * One refresh: flush the pending decisions, fetch, cache, re-apply what the phone decided while the
 * fetch was in flight, mark the drives already opened from their notification, and answer from the
 * cache. Offline (known, or discovered by a failed request) → the cache as it stands.
 */
export async function loadInbox(
  db: Db,
  deps: { api: InboxApi; online: boolean; now: number }
): Promise<InboxSnapshot> {
  const cache = createInboxCache(db);
  if (!deps.online) return { rows: await cache.list(), offline: true };
  try {
    await flushPending(db, deps.api);
    const rows = await deps.api.fetchInbox();
    await cache.replaceAll(rows);
    await reapplyPending(db, deps.now);
    await applyOpenedTrips(db, rows, deps.now);
  } catch (error) {
    if (isOffline(error)) return { rows: await cache.list(), offline: true };
    throw error;
  }
  // The opened-trip reads just queued: send them now if the server will take them.
  await flushPending(db, deps.api).catch(() => undefined);
  return { rows: await cache.list(), offline: false };
}

/**
 * What the phone holds about each drive, for the rows' current-state copy: four statements for
 * any number of drives (the tombstones, the scored count, the trips `IN`, their events `IN`).
 */
export async function readInboxLocals(
  db: Db,
  clientTripIds: readonly string[]
): Promise<Record<string, InboxLocal>> {
  const out: Record<string, InboxLocal> = {};
  const ids = [...new Set(clientTripIds)];
  if (ids.length === 0) return out;
  const marks = ids.map(() => '?').join(', ');
  const tombstones = await readTombstones(db);
  const { rows: countRows } = await db.execute(
    `SELECT COUNT(*) AS n FROM trips WHERE deleted_at IS NULL AND score IS NOT NULL
       AND status IN ('provisional', 'final')`
  );
  const scored = Number(countRows[0]?.n ?? 0);
  const { rows: tripRows } = await db.execute(
    `SELECT * FROM trips WHERE client_trip_id IN (${marks})`,
    ids
  );
  const trips = new Map(tripRows.map(toTripRow).map((r) => [r.client_trip_id, r]));
  const live = ids.filter((id) => trips.get(id)?.deleted_at === null);
  const events = new Map<string, TripEventView[]>();
  if (live.length > 0) {
    const { rows: eventRows } = await db.execute(
      `SELECT * FROM trip_events WHERE client_trip_id IN (${live.map(() => '?').join(', ')})
         ORDER BY started_at ASC, id ASC`,
      live
    );
    for (const raw of eventRows) {
      const row = toEventRow(raw);
      const list = events.get(row.client_trip_id) ?? [];
      list.push(toTripEventView(row));
      events.set(row.client_trip_id, list);
    }
  }
  for (const id of ids) {
    const row = trips.get(id);
    out[id] =
      row === undefined
        ? { trip: null, events: [], deleted: tombstones.has(id) }
        : { trip: toTripDetail(row, scored), events: events.get(id) ?? [] };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

function useUid(): string | null {
  return useSession().session?.user.id ?? null;
}

/** The inbox rows. Disabled while signed out. */
export function useInbox<T = InboxSnapshot>(
  deps: InboxDeps = {},
  select?: (snapshot: InboxSnapshot) => T
): UseQueryResult<T> {
  const { db, now } = useDataSource();
  const uid = useUid();
  const api = deps.api ?? defaultInboxApi;
  const online = useOnline();
  const queryClient = useQueryClient();
  const key = useMemo(() => inboxKey(uid ?? ''), [uid]);

  const query = useQuery({
    queryKey: key,
    queryFn: () => loadInbox(db, { api, online: getSharedOnline(), now: now() }),
    enabled: uid !== null,
    staleTime: INBOX_STALE_MS,
    select,
  });

  // Foreground: refetch only what is stale and mounted. `cancelRefetch: false` joins a fetch
  // already in flight rather than restarting it (the bell and the screen both listen).
  const appState = deps.appState ?? AppState;
  useEffect(() => {
    if (uid === null) return;
    const sub = appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      // Staleness by the clock, not the observer's own stale timer: that timer may not have run
      // while the phone slept.
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      if (Date.now() - updatedAt < INBOX_STALE_MS) return;
      void queryClient
        .refetchQueries({ queryKey: key, type: 'active' }, { cancelRefetch: false })
        .catch(() => undefined);
    });
    return () => sub.remove();
  }, [appState, key, queryClient, uid]);

  // Back online after an offline answer: fetch once.
  const wasOffline = queryClient.getQueryData<InboxSnapshot>(key)?.offline === true;
  useEffect(() => {
    if (!online || !wasOffline || uid === null) return;
    void queryClient
      .refetchQueries({ queryKey: key, type: 'active' }, { cancelRefetch: false })
      .catch(() => undefined);
  }, [online, wasOffline, key, queryClient, uid]);

  return query;
}

/** Rows the list shows and the bell counts: not dismissed, and renderable by this build. */
export function shownRows(rows: readonly InboxRow[]): InboxRow[] {
  return rows.filter(
    (row) => isVisibleRow(row) && renderInboxBase(row.type as NotificationType, row.payload) !== null
  );
}

const unreadOf = (s: InboxSnapshot): number => shownRows(s.rows).filter((r) => r.read_at === null).length;

/** How many rows the list would show as unread. 0 until known. */
export function useUnreadCount(deps: InboxDeps = {}): number {
  return useInbox(deps, unreadOf).data ?? 0;
}

/**
 * The list's items: the shown rows, each rendered from its drive's current state. The locals are
 * read under the `['trip']` root, so every trip change (a role answered, a delete, a sync, a
 * restore) refreshes them through the data layer's own invalidation.
 */
export function useInboxItems(deps: InboxDeps = {}, tz: string = deviceZone()) {
  const { db, now } = useDataSource();
  const inbox = useInbox(deps);
  const rows = useMemo(() => shownRows(inbox.data?.rows ?? []), [inbox.data]);
  const tripIds = useMemo(
    () =>
      [...new Set(rows.map(clientTripIdOf).filter((id): id is string => id !== null))].sort(),
    [rows]
  );
  const locals = useQuery({
    queryKey: ['trip', 'inbox-locals', tripIds] as const,
    queryFn: () => readInboxLocals(db, tripIds),
    enabled: inbox.data !== undefined,
  });

  // Lapse rows are told from the phone's permissions now: read when the list has one, on every
  // mount (staleTime 0), and again on a return to the foreground (back from Settings).
  const hasLapse = rows.some((row) => row.type === 'permission_lapsed');
  const adapter = deps.permissions ?? defaultPermissionsAdapter();
  const permissions = useQuery({
    queryKey: PERMISSIONS_NOW_KEY,
    queryFn: () => readPermissionsNow(db, adapter),
    enabled: hasLapse,
    staleTime: 0,
  });
  const appState = deps.appState ?? AppState;
  const { refetch: refetchPermissions } = permissions;
  useEffect(() => {
    if (!hasLapse) return;
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') void refetchPermissions().catch(() => undefined);
    });
    return () => sub.remove();
  }, [appState, hasLapse, refetchPermissions]);

  const items = useMemo<InboxItemView[] | undefined>(() => {
    if (inbox.data === undefined || locals.data === undefined) return undefined;
    if (hasLapse && permissions.data === undefined) return undefined;
    const at = now();
    const none: InboxLocal = { trip: null, events: [] };
    const lapseLocal: InboxLocal = { trip: null, events: [], permissions: permissions.data ?? null };
    return rows
      .map((row) => {
        if (row.type === 'permission_lapsed') return toItemView(row, lapseLocal, at, tz);
        const trip = clientTripIdOf(row);
        return toItemView(row, trip === null ? none : (locals.data[trip] ?? none), at, tz);
      })
      .filter((v): v is InboxItemView => v !== null);
  }, [inbox.data, locals.data, hasLapse, permissions.data, rows, now, tz]);
  return { inbox, locals, items, offline: inbox.data?.offline === true };
}

/** The device's zone, the one "Today" is decided in: normalised, as the cap and push-sender use (m2). */
export { deviceZone };

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

async function publishCache(queryClient: QueryClient, db: Db, uid: string): Promise<void> {
  const rows = await createInboxCache(db).list();
  queryClient.setQueryData<InboxSnapshot>(inboxKey(uid), (old) => ({
    rows,
    offline: old?.offline ?? !getSharedOnline(),
  }));
}

function useInboxMutation(
  queue: (db: Db, ids: readonly string[], now: number) => Promise<void>,
  deps: InboxDeps
) {
  const { db, now } = useDataSource();
  const uid = useUid();
  const queryClient = useQueryClient();
  const api = deps.api ?? defaultInboxApi;
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      if (uid === null || ids.length === 0) return;
      await queue(db, ids, now());
      await publishCache(queryClient, db, uid);
      // Sent now when possible; otherwise it waits in the pending set for the next fetch.
      if (getSharedOnline()) await flushPending(db, api).catch(() => undefined);
    },
  });
}

/** Mark rows read (phone first, then the server). */
export function useMarkRead(deps: InboxDeps = {}) {
  return useInboxMutation(queueInboxRead, deps);
}

/** Dismiss rows (phone first, then the server). */
export function useDismiss(deps: InboxDeps = {}) {
  return useInboxMutation(queueInboxDismiss, deps);
}

/** Mark every shown unread row read. */
export function useMarkAllRead(deps: InboxDeps = {}) {
  const inbox = useInbox(deps);
  const markRead = useMarkRead(deps);
  const { mutateAsync } = markRead;
  const markAll = useCallback(async () => {
    const ids = shownRows(inbox.data?.rows ?? [])
      .filter((r) => r.read_at === null)
      .map((r) => r.id);
    await mutateAsync(ids);
  }, [inbox.data, mutateAsync]);
  return { ...markRead, markAll };
}
