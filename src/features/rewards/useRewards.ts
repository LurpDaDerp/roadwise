/**
 * The rewards data hooks.
 *
 * **Freshness without polling (design §3.5).** The snapshot is fetched when a rewards surface
 * mounts and its data is older than 5 minutes, when the app comes to the foreground with stale data,
 * when the connection comes back after an offline answer, after the data layer's change event (a
 * landed sync: `'rewards'` is one of `QUERY_ROOTS`, so `subscribeInvalidation` reaches it), and
 * when a notification arrives (the notification host invalidates
 * `REWARDS_QUERY_KEY`). Nothing runs on a timer, and nothing runs in the background.
 *
 * **Offline.** With no connection — or when the request cannot reach the server — the answer is the
 * phone's cached snapshot for this account with `offline: true`. With nothing cached for this
 * account, the query fails with `RewardsOfflineError` (never another account's rewards). A server
 * that answered with a refusal is an error, which the screen shows with a retry.
 *
 * **Mutations** (focus, join, leave) call the server directly and invalidate every rewards query on
 * success; offline they are refused as `RewardsRpcError('offline')` without a request.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { getSharedOnline } from '@/data/net/net';
import { useOnline } from '@/data/net/useOnline';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';

import {
  defaultRewardsApi,
  RewardsOfflineError,
  RewardsRpcError,
  SNAPSHOT_DAYS,
  type GoalCategory,
  type RewardDay,
  type RewardsApi,
  type RewardsSnapshot,
} from './api';
import { readCachedRewards, writeCachedRewards } from './cache';
import { dayAward, type DayAward } from './viewModel';
import { rewardDayKey, rewardsKey, REWARDS_QUERY_KEY, REWARDS_STALE_MS } from './keys';

/** The snapshot, and whether it came from the phone's cache because the server was out of reach. */
export interface RewardsData {
  snapshot: RewardsSnapshot;
  offline: boolean;
}

export interface RewardsDeps {
  api?: RewardsApi;
  appState?: AppStateLike;
}

// ---------------------------------------------------------------------------------------------
// The loads (pure over a Db and an api, so they are tested without React)
// ---------------------------------------------------------------------------------------------

/** One refresh: fetch and cache, or — offline or unreachable — this account's cached snapshot. */
export async function loadRewards(
  db: Db,
  deps: { api: RewardsApi; online: boolean; uid: string }
): Promise<RewardsData> {
  const settings = createSettingsRepo(db);
  const fromCache = async (cause?: unknown): Promise<RewardsData> => {
    const snapshot = await readCachedRewards(settings, deps.uid);
    if (snapshot === null) throw new RewardsOfflineError(cause);
    return { snapshot, offline: true };
  };
  if (!deps.online) return fromCache();
  let snapshot: RewardsSnapshot;
  try {
    snapshot = await deps.api.fetchSnapshot();
  } catch (error) {
    if (error instanceof RewardsOfflineError) return fromCache(error);
    throw error;
  }
  // A cache that will not write costs the next offline answer, not this one.
  await writeCachedRewards(settings, deps.uid, snapshot).catch(() => undefined);
  return { snapshot, offline: false };
}

/**
 * Whether the snapshot alone answers for `day`: its row is there, or — the snapshot holds every
 * settled day (fewer than its 35), or `day` is not older than its oldest — the day has no row
 * because it has not settled. Days settle in order, so a gap inside the window is a day with none.
 */
export function snapshotCoversDay(snapshot: RewardsSnapshot, day: string): boolean {
  if (snapshot.days.some((d) => d.day === day)) return true;
  if (snapshot.days.length < SNAPSHOT_DAYS) return true;
  const oldest = snapshot.days[snapshot.days.length - 1]?.day;
  return oldest !== undefined && day >= oldest;
}

const findDay = (snapshot: RewardsSnapshot, day: string): RewardDay | null =>
  snapshot.days.find((d) => d.day === day) ?? null;

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

function useUid(): string | null {
  return useSession().session?.user.id ?? null;
}

/** The snapshot query alone (no listeners), optionally projected. */
function useRewardsQuery<T = RewardsData>(deps: RewardsDeps, select?: (data: RewardsData) => T): UseQueryResult<T> {
  const { db } = useDataSource();
  const uid = useUid();
  const api = deps.api ?? defaultRewardsApi;
  return useQuery({
    queryKey: rewardsKey(uid ?? ''),
    queryFn: () => loadRewards(db, { api, online: getSharedOnline(), uid: uid as string }),
    enabled: uid !== null,
    staleTime: REWARDS_STALE_MS,
    select,
  });
}

const refetchActive = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.refetchQueries({ queryKey: key, type: 'active' }, { cancelRefetch: false }).catch(() => undefined);

/**
 * The rewards snapshot for the signed-in account. Disabled while signed out. Key
 * `[...REWARDS_QUERY_KEY, uid]`, 5-minute stale.
 */
export function useRewards(deps: RewardsDeps = {}): UseQueryResult<RewardsData> {
  const uid = useUid();
  const online = useOnline();
  const queryClient = useQueryClient();
  const key = useMemo(() => rewardsKey(uid ?? ''), [uid]);
  const query = useRewardsQuery(deps);

  // Foreground: refetch only when stale, by the clock (the observer's own stale timer may not have
  // run while the phone slept). `cancelRefetch: false` joins a fetch already in flight.
  const appState = deps.appState ?? AppState;
  useEffect(() => {
    if (uid === null) return;
    const sub = appState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
      if (Date.now() - updatedAt < REWARDS_STALE_MS) return;
      void refetchActive(queryClient, key);
    });
    return () => sub.remove();
  }, [appState, key, queryClient, uid]);

  // Back online after an offline answer: fetch once.
  const wasOffline = query.data?.offline === true;
  useEffect(() => {
    if (!online || !wasOffline || uid === null) return;
    void refetchActive(queryClient, key);
  }, [online, wasOffline, key, queryClient, uid]);

  return query;
}

/**
 * One day's settled reward, or null when it has not settled. The snapshot's row when the snapshot
 * answers for the day (`snapshotCoversDay`); otherwise one owner select of that `reward_days` row
 * (key `[...REWARDS_QUERY_KEY, 'day', uid, day]`, 5-minute stale), so an older drive's day is never
 * read as "not settled yet" just because it fell out of the newest 35. Offline, a day the cached
 * snapshot does not hold is an error (`RewardsOfflineError`), never null: it may have settled since.
 *
 * **null means "no row", not "not settled yet"** (T7 round 1, I1): a day before `rewards_start`, or
 * at or behind `settled_through`, has no row and never will. Pass the row to `dayAward(row, { day,
 * progress })`, or use `useDayAward(day)`, which does that with the snapshot's progress.
 */
export function useRewardDay(day: string, deps: RewardsDeps = {}): UseQueryResult<RewardDay | null> {
  const uid = useUid();
  const api = deps.api ?? defaultRewardsApi;
  const rewards = useRewards(deps);
  const data = rewards.data;
  // An offline snapshot answers only for the days it holds: a day missing from a cached copy may
  // have settled since it was saved, so it is asked for (and, still offline, is an error — unknown).
  const covered =
    data === undefined ||
    data.snapshot.days.some((d) => d.day === day) ||
    (!data.offline && snapshotCoversDay(data.snapshot, day));
  const fromSnapshot = useRewardsQuery(deps, (data) => findDay(data.snapshot, day));
  const fromServer = useQuery({
    queryKey: rewardDayKey(uid ?? '', day),
    queryFn: async () => {
      if (!getSharedOnline()) throw new RewardsOfflineError();
      return api.fetchRewardDay(day);
    },
    enabled: uid !== null && !covered,
    staleTime: REWARDS_STALE_MS,
  });
  return covered ? fromSnapshot : fromServer;
}

/** `useDayAward`'s answer: the three-way award once known, or the reason it is not. */
export type DayAwardResult =
  | { status: 'pending'; data: undefined; error: null }
  | { status: 'error'; data: undefined; error: unknown }
  | { status: 'success'; data: DayAward; error: null };

/**
 * A day's award, three ways (`settled` | `pending` | `not_counted`, `dayAward`), from its row and the
 * snapshot's progress. The row comes from `useRewardDay`, which answers only from a fresh snapshot or
 * the server (offline, a day the saved copy lacks is an error), so the progress it is judged against
 * is as fresh as the row. Unknown stays unknown: `status: 'error'` or `'pending'`, never a guess.
 * Pass `hadScoredDrive: true` when the day is known to have a scored driver drive (D1): a frozen late
 * day's "no drive" row then reads `not_counted` / `after_confirmed` (round 2, m2).
 */
export function useDayAward(
  day: string,
  deps: RewardsDeps = {},
  opts: { hadScoredDrive?: boolean } = {}
): DayAwardResult {
  const row = useRewardDay(day, deps);
  const rewards = useRewards(deps);
  const progress = rewards.data?.snapshot.progress;
  return useMemo<DayAwardResult>(() => {
    if (row.status === 'error') return { status: 'error', data: undefined, error: row.error };
    if (row.status === 'pending' || progress === undefined) return { status: 'pending', data: undefined, error: null };
    return {
      status: 'success',
      data: dayAward(row.data, { day, progress, hadScoredDrive: opts.hadScoredDrive }),
      error: null,
    };
  }, [day, opts.hadScoredDrive, progress, row.data, row.error, row.status]);
}

function useRewardsMutation<A, R>(deps: Pick<RewardsDeps, 'api'>, call: (api: RewardsApi, arg: A) => Promise<R>) {
  const queryClient = useQueryClient();
  const api = deps.api ?? defaultRewardsApi;
  return useMutation({
    mutationFn: async (arg: A) => {
      if (!getSharedOnline()) throw new RewardsRpcError('offline');
      return call(api, arg);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REWARDS_QUERY_KEY }).catch(() => undefined),
  });
}

/** Choose this week's (or, once a day has counted, next week's) focus. Answer: where it applied. */
export function useSetWeeklyFocus(deps: Pick<RewardsDeps, 'api'> = {}) {
  return useRewardsMutation(deps, (api, category: GoalCategory) => api.setWeeklyFocus(category));
}

/** Join a challenge by its def id. */
export function useJoinChallenge(deps: Pick<RewardsDeps, 'api'> = {}) {
  return useRewardsMutation(deps, (api, defId: string) => api.joinChallenge(defId));
}

/** Leave an active enrolment by its id. */
export function useLeaveChallenge(deps: Pick<RewardsDeps, 'api'> = {}) {
  return useRewardsMutation(deps, (api, id: string) => api.leaveChallenge(id));
}
