/**
 * Makes sure this week's goal exists (§R5): when the snapshot's newest goal is missing or belongs to
 * an earlier ISO week than the device's, `open_my_week()` is called — once per app session per
 * account and week, the week being the one the server answers with (see below) — and the rewards
 * are then refetched. The server also closes any earlier goal whose week has closed in the same
 * call (rev1: R-I m8).
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

/**
 * What this session asked the server, per account: the device's week at the time, the week the
 * server answered with (null while in flight, or after a refusal that is spent), and when.
 */
interface Attempt {
  deviceWeek: string;
  serverWeek: string | null;
  at: number;
}
const attempts = new Map<string, Attempt>();

/**
 * When the server answered with an earlier week than the device's (the phone's zone is ahead of the
 * account's `user_tz` around Monday midnight), ask again no sooner than this after the last answer.
 * No timer: it rides the next rewards answer (a foreground, a sync, a mount).
 */
export const SERVER_WEEK_RETRY_MS = 60 * 60 * 1000;

/** Tests only: forget what this session opened. */
export function resetEnsureWeekForTests(): void {
  attempts.clear();
}

/**
 * The week is the SERVER's (final review m9): `open_my_week` decides it in the account's zone and
 * answers with its goal. The device's week only says when to ask. A call whose answer is this
 * device week (or later) settles the week for the session; an answer with an earlier week (the
 * server's Monday has not come yet) is not taken as "opened", and the call is repeated at the next
 * answer at least `SERVER_WEEK_RETRY_MS` later, until the server's week arrives.
 */
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
    const at = now();
    const deviceWeek = isoWeekStart(dayKey(new Date(at), deviceZone()));
    const goal = data.snapshot.currentGoal;
    if (goal !== null && goal.week_start >= deviceWeek) return;
    const last = attempts.get(uid);
    if (last !== undefined && last.deviceWeek === deviceWeek) {
      // In flight, spent by a refusal, or the server has already opened this week: nothing to do.
      if (last.serverWeek === null || last.serverWeek >= deviceWeek) return;
      // The server answered with an earlier week: its Monday had not come. Ask again later.
      if (at - last.at < SERVER_WEEK_RETRY_MS) return;
    }
    const attempt: Attempt = { deviceWeek, serverWeek: null, at };
    attempts.set(uid, attempt);
    void api.openMyWeek().then(
      (answer) => {
        attempt.serverWeek = answer.week_start;
        attempt.at = now();
        return queryClient.invalidateQueries({ queryKey: REWARDS_QUERY_KEY }).catch(() => undefined);
      },
      (error: unknown) => {
        if (error instanceof RewardsRpcError && (error.code === 'offline' || error.code === 'busy')) {
          if (attempts.get(uid) === attempt) attempts.delete(uid);
        }
      }
    );
  }, [answeredAt, api, data, now, online, queryClient, uid]);
}
