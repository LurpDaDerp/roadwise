/**
 * Makes sure this week's goal exists (§R5): when the snapshot's newest goal is missing or belongs to
 * an earlier ISO week than the device's, `open_my_week()` is called — at most once per app session
 * per account and week (an in-memory guard) — and the rewards are then refetched. The server also
 * closes any earlier goal whose week has closed in the same call (rev1: R-I m8).
 *
 * Never while offline, and never on the strength of the offline cache. A call that could not reach
 * the server, or met a lock timeout, is not spent: the next online answer tries again. Any other
 * refusal (an ineligible account) is spent for the session.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useOnline } from '@/data/net/useOnline';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';

import { defaultRewardsApi, RewardsRpcError } from './api';
import { REWARDS_QUERY_KEY } from './keys';
import { useRewards, type RewardsDeps } from './useRewards';
import { isoWeekStart } from './viewModel';

/** `uid:weekStart` of every week this session has opened. */
const opened = new Set<string>();

/** Tests only: forget what this session opened. */
export function resetEnsureWeekForTests(): void {
  opened.clear();
}

export function useEnsureWeek(deps: RewardsDeps = {}): void {
  const { now } = useDataSource();
  const uid = useSession().session?.user.id ?? null;
  const online = useOnline();
  const queryClient = useQueryClient();
  const api = deps.api ?? defaultRewardsApi;
  const rewards = useRewards(deps);
  const data = rewards.data;
  // Each answer, even one equal to the last (structural sharing keeps `data`), is a new look.
  const answeredAt = rewards.dataUpdatedAt;

  useEffect(() => {
    if (uid === null || data === undefined || data.offline || !online) return;
    const week = isoWeekStart(dayKey(new Date(now()), deviceZone()));
    const goal = data.snapshot.currentGoal;
    if (goal !== null && goal.week_start >= week) return;
    const key = `${uid}:${week}`;
    if (opened.has(key)) return;
    opened.add(key);
    void api.openMyWeek().then(
      () => queryClient.invalidateQueries({ queryKey: REWARDS_QUERY_KEY }).catch(() => undefined),
      (error: unknown) => {
        if (error instanceof RewardsRpcError && (error.code === 'offline' || error.code === 'busy')) {
          opened.delete(key);
        }
      }
    );
  }, [answeredAt, api, data, now, online, queryClient, uid]);
}
