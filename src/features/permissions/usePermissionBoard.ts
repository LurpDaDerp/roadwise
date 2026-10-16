/**
 * The permission board for Home and Settings › Permissions: one read of the phone (shared with
 * every other reader through the health query) plus Home's stored prefs, and the actions on them.
 *
 * When it reads (never on a timer, never in the background): when the screen asks (Home on focus,
 * deduped within 2 s), every time RoadWise returns to the front, after a row's own request, on
 * pull to refresh, and when the DashPal link enters or leaves `unauthorized` or the pairing changes.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState, Platform } from 'react-native';

import type { TripReminderStatus } from '@drive-sense';

import type { PermissionsAdapter } from '@/core/permissions';
import { asPaired, PAIRED_KEY } from '@/dashcam/keys';
import { activeDashcam, subscribeActiveDashcam } from '@/dashcam/registry';
import { requestDeviceSync } from '@/data/devices/events';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { readReminderStatus } from '@/features/reminder/enable';

import { runFix, type FixOutcome } from './actions';
import { fixFor, readPermissionBoard, toSettingsApplies } from './board';
import { EMPTY_HOME_PREFS, hideOnHome, pruneToSettings, readHomePrefs, showOnHome, type HomePrefs } from './homePrefs';
import { permissionDef, signature, type PermissionBoardRead, type PermissionId } from './registry';
import { defaultPermissionsAdapter, permissionHealthKey, readPermissionHealth, SHARED_READ_MS } from './usePermissionHealth';

export const permissionBoardKey = (uid: string | null) => ['permissions', 'board', uid ?? ''] as const;
export const homePrefsKey = (uid: string | null) => ['permissions', 'home', uid ?? ''] as const;

/** `focus`: reuse a read under 2 s old. `shared`: read now, joining one in flight. `fresh`: read now. */
export type RefreshMode = 'focus' | 'shared' | 'fresh';

/**
 * Calls `onChange` when the DashPal link enters or leaves `unauthorized` or the pairing changes,
 * following the runtime across a handover. Returns the unsubscribe.
 */
export function watchDashcamPermissions(onChange: () => void): () => void {
  let last: string | null = null;
  let offRuntime: (() => void) | null = null;
  const key = () => {
    const rt = activeDashcam();
    if (!rt) return 'none';
    const { link } = rt.state();
    return `${link.lifecycle === 'unauthorized'}:${link.paired !== null}`;
  };
  const check = () => {
    const k = key();
    if (last !== null && k !== last) onChange();
    last = k;
  };
  const attach = () => {
    offRuntime?.();
    offRuntime = activeDashcam()?.subscribe(check) ?? null;
    check();
  };
  const offRegistry = subscribeActiveDashcam(attach);
  attach();
  return () => {
    offRegistry();
    offRuntime?.();
  };
}

const defaultAndroidApi = (): number | null => {
  if (Platform.OS !== 'android') return null;
  const v = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  return Number.isFinite(v) ? v : null;
};

const defaultEnsureChannels = async () => (await import('@/features/notifications/channels')).ensureAndroidChannels();

export interface PermissionBoardDeps {
  adapter?: PermissionsAdapter;
  appState?: AppStateLike;
  /** Default: the reminder's own status read (rejects where drive-sense is absent). */
  reminder?: () => Promise<TripReminderStatus>;
  androidApi?: number | null;
  /** Default: the live DashPal runtime (`watchDashcamPermissions`). */
  watchDashcam?: (onChange: () => void) => () => void;
  ensureChannels?: () => Promise<void>;
  requestDeviceSync?: () => void;
  now?: () => number;
}

export interface PermissionBoard {
  status: 'loading' | 'error' | 'ready';
  /** null until read, and when the phone could not be read. */
  read: PermissionBoardRead | null;
  prefs: HomePrefs;
  refresh(mode?: RefreshMode): Promise<void>;
  /** The tap on a missing row (no-op for one that is not missing). Rejects when the phone call failed. */
  fix(id: PermissionId, opts?: { markReturn?: boolean }): Promise<FixOutcome | null>;
  /** "Don't remind me again". Rejects when it could not be stored. */
  hide(id: PermissionId): Promise<void>;
  /** Show on Home. Rejects when it could not be stored. */
  show(id: PermissionId): Promise<void>;
}

export function usePermissionBoard(deps: PermissionBoardDeps = {}): PermissionBoard {
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const appState = deps.appState ?? AppState;
  const reminder = deps.reminder ?? readReminderStatus;
  const androidApi = deps.androidApi === undefined ? defaultAndroidApi() : deps.androidApi;
  const watch = deps.watchDashcam ?? watchDashcamPermissions;
  const now = deps.now ?? Date.now;
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const userId = useSession().session?.user.id ?? null;
  const queryClient = useQueryClient();
  const boardKey = useMemo(() => permissionBoardKey(userId), [userId]);
  const prefsKey = useMemo(() => homePrefsKey(userId), [userId]);

  const readBoard = useCallback(async (): Promise<PermissionBoardRead | null> => {
    try {
      return await readPermissionBoard({
        // Through the shared health query, so a return to the front reads the phone once.
        snapshot: async () => {
          const r = await queryClient.fetchQuery({
            queryKey: permissionHealthKey(userId),
            queryFn: () => readPermissionHealth(adapter),
            staleTime: 0,
            gcTime: 0,
            retry: false,
          });
          if (r === null) throw new Error('permissions unreadable');
          return r.snapshot;
        },
        androidApi,
        paired: async () => asPaired(await settings.get<unknown>(PAIRED_KEY)) !== null,
        bluetoothPermission: () => adapter.bluetoothPermission(),
        camera: () => adapter.camera(),
        reminder,
      });
    } catch {
      return null;
    }
  }, [queryClient, userId, adapter, androidApi, settings, reminder]);

  const board = useQuery({ queryKey: boardKey, queryFn: readBoard, staleTime: SHARED_READ_MS, retry: false });
  const prefsQuery = useQuery({ queryKey: prefsKey, queryFn: () => readHomePrefs(settings), staleTime: Infinity, retry: false });
  const prefs = prefsQuery.data ?? EMPTY_HOME_PREFS;
  // The board is not ready before the stored prefs are (a read for display never rejects; an error
  // still settles to empty prefs): a hidden row must never show, nor a tap run on empty marks.
  const prefsSettled = prefsQuery.data !== undefined || prefsQuery.isError;

  const { refetch } = board;
  const refresh = useCallback(
    async (mode: RefreshMode = 'shared') => {
      if (mode === 'focus') {
        void queryClient.refetchQueries({ queryKey: prefsKey, exact: true });
        const st = queryClient.getQueryState(boardKey);
        if (st?.status === 'success' && st.data !== null && !st.isInvalidated && Date.now() - st.dataUpdatedAt < SHARED_READ_MS) return;
      }
      await refetch({ cancelRefetch: mode === 'fresh' });
    },
    [queryClient, prefsKey, boardKey, refetch]
  );

  // Back from the phone's Settings (and on iOS after each permission alert).
  useEffect(() => {
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') void refresh('shared');
    });
    return () => sub.remove();
  }, [appState, refresh]);

  useEffect(() => watch(() => void refresh('shared')), [watch, refresh]);

  /**
   * Puts a stored change in the cache at once. A prefs read still in flight began before the write,
   * so it is cancelled rather than allowed to land over it; a read after the write settles the rest.
   */
  const commitPrefs = useCallback(
    async (patch: Partial<HomePrefs>) => {
      await queryClient.cancelQueries({ queryKey: prefsKey, exact: true });
      queryClient.setQueryData<HomePrefs>(prefsKey, (p) => ({ ...(p ?? EMPTY_HOME_PREFS), ...patch }));
      void queryClient.refetchQueries({ queryKey: prefsKey, exact: true });
    },
    [queryClient, prefsKey]
  );

  // Drop "next tap opens Settings" marks that no longer apply (best effort).
  const read = board.data ?? null;
  useEffect(() => {
    if (read === null) return;
    const stored = prefsQuery.data?.toSettings ?? {};
    const stale = (Object.entries(stored) as [PermissionId, string][]).some(([id, sig]) => !toSettingsApplies(read, id, sig));
    if (!stale) return;
    pruneToSettings(settings, (id, sig) => toSettingsApplies(read, id, sig))
      .then((toSettings) => commitPrefs({ toSettings }))
      .catch(() => {});
  }, [read, prefsQuery.data, settings, commitPrefs]);

  const fix = useCallback(
    async (id: PermissionId, opts: { markReturn?: boolean } = {}): Promise<FixOutcome | null> => {
      // The read and prefs the tap was made on.
      const r = read;
      if (r === null || !prefsSettled) return null;
      const state = permissionDef(id).state(r);
      const which = fixFor(id, state, prefs);
      if (which === null || state.kind !== 'missing') return null;
      const outcome = await runFix(id, state, which, {
        adapter,
        settings,
        now,
        markReturn: opts.markReturn,
        ensureChannels: r.snapshot.platform === 'android' ? (deps.ensureChannels ?? defaultEnsureChannels) : undefined,
        requestDeviceSync: deps.requestDeviceSync ?? requestDeviceSync,
        reread: async () => {
          await refresh('fresh');
          return queryClient.getQueryData<PermissionBoardRead | null>(boardKey) ?? null;
        },
      });
      if (outcome.kind === 'requested' && outcome.noEffect) {
        await commitPrefs({ toSettings: { ...prefs.toSettings, [id]: signature(state) } });
      }
      return outcome;
    },
    [read, prefsSettled, prefs, adapter, settings, now, deps.ensureChannels, deps.requestDeviceSync, refresh, queryClient, boardKey, commitPrefs]
  );

  const hide = useCallback(
    async (id: PermissionId) => {
      await commitPrefs({ hidden: await hideOnHome(settings, id) });
    },
    [settings, commitPrefs]
  );

  const show = useCallback(
    async (id: PermissionId) => {
      await commitPrefs({ hidden: await showOnHome(settings, id) });
    },
    [settings, commitPrefs]
  );

  const status: PermissionBoard['status'] =
    read !== null ? (prefsSettled ? 'ready' : 'loading') : board.isFetched && !board.isFetching ? 'error' : 'loading';
  return { status, read, prefs, refresh, fix, hide, show };
}
