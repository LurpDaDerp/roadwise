/**
 * The referral hooks.
 *
 * **Off unless the flag is on (R-F).** Every hook here reads `feature_flags.referral` from the
 * cached app config (compiled default false) and makes no request while it is off, before the
 * config is read, or while signed out. The server refuses the three RPCs with the flag off anyway.
 *
 * **Freshness without polling (design §3.5).** `my_referrals` is fetched when F10 or the join
 * screen mounts with data older than 5 minutes, on a return to the front with stale data, once
 * when the connection comes back after an offline answer, and when a notification arrives (the
 * notification host invalidates `REWARDS_QUERY_KEY`, which prefixes these keys). No timer.
 *
 * **Offline.** The answer is this account's cached counts (`referral.snapshot` in settings, one
 * uid) marked `offline`; with none cached the query fails with `ReferralError('offline')`, never
 * another account's. The handover wipe empties settings, so it never outlives the device's owner.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { AppState, Platform } from 'react-native';
import { z } from 'zod';

import { useAppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { getSharedOnline } from '@/data/net/net';
import { useOnline } from '@/data/net/useOnline';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { REWARDS_QUERY_KEY } from '@/features/rewards/keys';

import {
  defaultReferralApi,
  MyReferralsSchema,
  ReferralError,
  type MyReferrals,
  type RedeemAnswer,
  type ReferralApi,
} from './api';

// ---------------------------------------------------------------------------------------------
// Keys and the cache
// ---------------------------------------------------------------------------------------------

export const REFERRAL_STALE_MS = 5 * 60_000;

/** `['rewards', 'referrals', uid]`: under the rewards root, so a notification's invalidation reaches it. */
export const referralsKey = (uid: string) => [...REWARDS_QUERY_KEY, 'referrals', uid] as const;
/** The caller's own code, under the same prefix. */
export const referralCodeKey = (uid: string) => [...referralsKey(uid), 'code'] as const;

export const REFERRAL_CACHE_KEY = 'referral.snapshot';

const CachedSchema = z.object({ uid: z.string(), snapshot: MyReferralsSchema }).strict();

export async function readCachedReferrals(
  settings: Pick<SettingsRepo, 'get'>,
  uid: string
): Promise<MyReferrals | null> {
  try {
    const parsed = CachedSchema.safeParse(await settings.get<unknown>(REFERRAL_CACHE_KEY));
    if (!parsed.success || parsed.data.uid !== uid) return null;
    return parsed.data.snapshot;
  } catch {
    return null;
  }
}

export async function writeCachedReferrals(
  settings: Pick<SettingsRepo, 'set'>,
  uid: string,
  snapshot: MyReferrals
): Promise<void> {
  await settings.set(REFERRAL_CACHE_KEY, { uid, snapshot });
}

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export interface ReferralDeps {
  api?: ReferralApi;
  appState?: AppStateLike;
  /** The app-config refresh `useAppConfig` runs when its cache is an hour old (tests pass a no-op). */
  refreshConfig?: () => Promise<void>;
}

export interface ReferralAvailability {
  /** The config cache has been read; until then nothing is shown as on or off. */
  ready: boolean;
  /** `feature_flags.referral`, default false. */
  available: boolean;
  /** This platform's store link, when the config has one. */
  storeUrl: string | null;
}

/** The referral flag and this platform's store link, from the cached app config. */
export function useReferralAvailability(deps: Pick<ReferralDeps, 'refreshConfig' | 'appState'> = {}): ReferralAvailability {
  const { config, ready } = useAppConfig({ refresh: deps.refreshConfig, appState: deps.appState });
  const urls = config.store_urls;
  const storeUrl = Platform.OS === 'ios' ? urls.ios : Platform.OS === 'android' ? urls.android : undefined;
  return { ready, available: ready && config.flags.referral === true, storeUrl: storeUrl ?? null };
}

// ---------------------------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------------------------

export interface ReferralsData {
  snapshot: MyReferrals;
  /** From the phone's cache because the server was out of reach. */
  offline: boolean;
}

export async function loadReferrals(
  db: Db,
  deps: { api: ReferralApi; online: boolean; uid: string }
): Promise<ReferralsData> {
  const settings = createSettingsRepo(db);
  const fromCache = async (cause?: unknown): Promise<ReferralsData> => {
    const snapshot = await readCachedReferrals(settings, deps.uid);
    if (snapshot === null) throw new ReferralError('offline', cause);
    return { snapshot, offline: true };
  };
  if (!deps.online) return fromCache();
  let snapshot: MyReferrals;
  try {
    snapshot = await deps.api.fetchMyReferrals();
  } catch (error) {
    if (error instanceof ReferralError && error.code === 'offline') return fromCache(error);
    throw error;
  }
  await writeCachedReferrals(settings, deps.uid, snapshot).catch(() => undefined);
  return { snapshot, offline: false };
}

/** The code: the server's (creating it once), or offline the cached one. */
export async function loadMyCode(db: Db, deps: { api: ReferralApi; online: boolean; uid: string }): Promise<string> {
  const settings = createSettingsRepo(db);
  const fromCache = async (cause?: unknown): Promise<string> => {
    const code = (await readCachedReferrals(settings, deps.uid))?.code ?? null;
    if (code === null) throw new ReferralError('offline', cause);
    return code;
  };
  if (!deps.online) return fromCache();
  let code: string;
  try {
    code = await deps.api.getMyReferralCode();
  } catch (error) {
    if (error instanceof ReferralError && error.code === 'offline') return fromCache(error);
    throw error;
  }
  // A cached snapshot fetched before the code existed gains it, so the code shows offline later.
  try {
    const cached = await readCachedReferrals(settings, deps.uid);
    if (cached !== null && cached.code === null) await writeCachedReferrals(settings, deps.uid, { ...cached, code });
  } catch {
    // The next snapshot carries it anyway.
  }
  return code;
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

function useUid(): string | null {
  return useSession().session?.user.id ?? null;
}

const refetchActive = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.refetchQueries({ queryKey: key, type: 'active' }, { cancelRefetch: false }).catch(() => undefined);

/**
 * Counts, the cap and the caller's own status (`my_referrals`), for the signed-in account, only
 * while the flag is on (and `enabled`, default true: the join screen passes false for a bad link). Key `[...REWARDS_QUERY_KEY, 'referrals', uid]`, 5-minute stale.
 */
export function useReferrals(deps: ReferralDeps & { enabled?: boolean } = {}): UseQueryResult<ReferralsData> {
  const { db } = useDataSource();
  const uid = useUid();
  const online = useOnline();
  const queryClient = useQueryClient();
  const { available } = useReferralAvailability(deps);
  const api = deps.api ?? defaultReferralApi;
  const key = useMemo(() => referralsKey(uid ?? ''), [uid]);
  const enabled = uid !== null && available && (deps.enabled ?? true);

  const query = useQuery({
    queryKey: key,
    queryFn: () => loadReferrals(db, { api, online: getSharedOnline(), uid: uid as string }),
    enabled,
    staleTime: REFERRAL_STALE_MS,
  });

  // Foreground: refetch only when stale by the clock (the observer's own timer may not have run).
  const appState = deps.appState ?? AppState;
  useEffect(() => {
    if (!enabled) return;
    const sub = appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      if (Date.now() - updatedAt < REFERRAL_STALE_MS) return;
      void refetchActive(queryClient, key);
    });
    return () => sub.remove();
  }, [appState, enabled, key, queryClient]);

  // Back online after an offline answer: fetch once.
  const wasOffline = query.data?.offline === true;
  useEffect(() => {
    if (!online || !wasOffline || !enabled) return;
    void refetchActive(queryClient, key);
  }, [online, wasOffline, enabled, key, queryClient]);

  return query;
}

/**
 * The caller's own code, fetched only when a screen needs it (`enabled`, default true: F10; the
 * share card passes its toggle) and the flag is on. The code is permanent, so it is never stale.
 */
export function useMyReferralCode(deps: ReferralDeps & { enabled?: boolean } = {}): UseQueryResult<string> {
  const { db } = useDataSource();
  const uid = useUid();
  const { available } = useReferralAvailability(deps);
  const api = deps.api ?? defaultReferralApi;
  return useQuery({
    queryKey: referralCodeKey(uid ?? ''),
    queryFn: () => loadMyCode(db, { api, online: getSharedOnline(), uid: uid as string }),
    enabled: uid !== null && available && (deps.enabled ?? true),
    staleTime: Infinity,
  });
}

/** Refusals after which the caller's own status may have changed: it is read again. */
const REFRESH_AFTER: ReadonlySet<string> = new Set(['window_closed', 'already_used', 'not_available']);

/**
 * Use a friend's code. Offline it is refused (`ReferralError('offline')`) without a request. On
 * success — and after a refusal that says the account's own status changed — the counts and
 * status are read again. Only ever called from a tap: nothing here runs by itself.
 */
export function useRedeemReferralCode(deps: Pick<ReferralDeps, 'api'> = {}) {
  const queryClient = useQueryClient();
  const api = deps.api ?? defaultReferralApi;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [...REWARDS_QUERY_KEY, 'referrals'] }).catch(() => undefined);
  return useMutation<RedeemAnswer, unknown, string>({
    mutationFn: async (input) => {
      if (!getSharedOnline()) throw new ReferralError('offline');
      return api.redeemReferralCode(input);
    },
    onSuccess: () => refresh(),
    onError: (error) => {
      if (error instanceof ReferralError && REFRESH_AFTER.has(error.code)) void refresh();
    },
  });
}
