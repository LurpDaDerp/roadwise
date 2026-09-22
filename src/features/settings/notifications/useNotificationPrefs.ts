/**
 * H6's data: the driver's notification preferences as they are in force (the row where it says
 * something, `app_config.notification_defaults` elsewhere), and a save that writes only the fields
 * the driver changed.
 *
 * Every read and every save also writes the effective preferences to `PREFS_CACHE_KEY`, which the
 * local notifier reads offline. The query is fetched when the screen mounts; nothing polls.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppConfig, type UseAppConfigDeps } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { PREFS_QUERY_KEY } from '@/notifications/keys';
import { effectivePrefs, writePrefsCache, type EffectivePrefs } from '@/notifications/localDelivery';

import { currentZone, readPrefs, savePrefs, type PrefsClient, type PrefsPatch, type PrefsRow } from './api';

export interface NotificationPrefsDeps {
  /** Default: the app's Supabase client. */
  client?: PrefsClient;
  /** Default: the phone's zone (normalised). */
  zone?: () => string;
  appConfig?: UseAppConfigDeps;
}

export type PrefsError = 'load' | 'save' | null;

export interface NotificationPrefsState {
  /** In force now, with a save in flight shown as made; null until the row is read. */
  prefs: EffectivePrefs | null;
  /** The zone quiet hours are read in. */
  zone: string;
  /** Writes `patch` (a category patch is merged with the row's other categories). Never rejects. */
  save: (patch: PrefsPatch) => Promise<void>;
  saving: boolean;
  error: PrefsError;
  /** Reloads after a load error, or re-sends the save that failed. */
  retry: () => void;
}

export const prefsKey = (uid: string | null) => [...PREFS_QUERY_KEY, uid] as const;

/** A patch applied to a row, for showing a save in flight. */
function applied(row: PrefsRow | null, patch: PrefsPatch | null): PrefsRow | null {
  if (patch === null) return row;
  const base: PrefsRow = row ?? {
    user_id: '',
    categories: {},
    quiet_enabled: null,
    quiet_start: null,
    quiet_end: null,
    tz: null,
    local_sent_day: null,
    local_sent_count: 0,
  };
  return { ...base, ...patch, categories: { ...base.categories, ...patch.categories } } as PrefsRow;
}

export function useNotificationPrefs(deps: NotificationPrefsDeps = {}): NotificationPrefsState {
  const { db } = useDataSource();
  const uid = useSession().session?.user.id ?? null;
  const client = useQueryClient();
  const { config } = useAppConfig(deps.appConfig);
  const defaults = config.notification_defaults;
  const zoneOf = deps.zone ?? currentZone;
  const zone = useMemo(() => zoneOf(), [zoneOf]);
  const settings = useMemo(() => createSettingsRepo(db), [db]);

  const query = useQuery({
    queryKey: prefsKey(uid),
    queryFn: () => readPrefs(uid as string, deps.client),
    enabled: uid !== null,
    retry: false,
  });

  const [pending, setPending] = useState<PrefsPatch | null>(null);
  const failed = useRef<PrefsPatch | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const mutation = useMutation({
    mutationFn: (patch: PrefsPatch) => savePrefs(uid as string, patch, deps.client),
    onSuccess: (row) => {
      client.setQueryData(prefsKey(uid), row);
    },
  });

  const row = query.data;
  // The cache follows every read and every save (and a change of the config defaults).
  useEffect(() => {
    if (row === undefined) return;
    void writePrefsCache(settings, effectivePrefs(row, defaults)).catch(() => undefined);
  }, [row, defaults, settings]);

  const { mutateAsync } = mutation;
  const send = useCallback(
    async (patch: PrefsPatch) => {
      setPending(patch);
      setSaveFailed(false);
      try {
        await mutateAsync(patch);
        failed.current = null;
      } catch {
        failed.current = patch;
        setSaveFailed(true);
      } finally {
        setPending(null);
      }
    },
    [mutateAsync]
  );

  const save = useCallback(
    (patch: PrefsPatch) => {
      if (uid === null || row === undefined) return Promise.resolve();
      // The categories column is one object: send the whole of it, changed key included.
      const full: PrefsPatch = patch.categories
        ? { ...patch, categories: { ...(row?.categories ?? {}), ...patch.categories } }
        : patch;
      return send(full);
    },
    [uid, row, send]
  );

  const { refetch } = query;
  const retry = useCallback(() => {
    if (failed.current) {
      void send(failed.current);
      return;
    }
    void refetch();
  }, [refetch, send]);

  const shown = row === undefined ? null : effectivePrefs(applied(row, pending), defaults);
  const error: PrefsError = query.isError ? 'load' : saveFailed ? 'save' : null;

  return { prefs: shown, zone, save, saving: pending !== null, error, retry };
}
