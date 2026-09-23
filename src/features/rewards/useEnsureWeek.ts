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
import { useEffect, useSyncExternalStore } from 'react';

import { useOnline } from '@/data/net/useOnline';
import { useDataSource } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';

import { defaultRewardsApi, RewardsRpcError, type RewardsSnapshot } from './api';
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

/** The week `open_my_week` last answered with, per account, this session, and the device's week then. */
const serverWeeks = new Map<string, AnsweredWeek>();
const weekListeners = new Set<() => void>();

function noteServerWeek(uid: string, answered: AnsweredWeek): void {
  const last = serverWeeks.get(uid);
  if (last?.week === answered.week && last.deviceWeek === answered.deviceWeek) return;
  serverWeeks.set(uid, answered);
  for (const listener of [...weekListeners]) listener();
}

function subscribeServerWeek(listener: () => void): () => void {
  weekListeners.add(listener);
  return () => {
    weekListeners.delete(listener);
  };
}

/** Tests only: forget what this session opened. */
export function resetEnsureWeekForTests(): void {
  attempts.clear();
  serverWeeks.clear();
}

/** The widest gap between two zones' clocks (UTC+14 to UTC-12). */
export const ZONE_SPREAD_MS = 26 * 60 * 60 * 1000;

/** The instant the device's week `week` (a Monday) began, in `zone`. */
function weekBeganAt(week: string, zone: string, near: number): number {
  // The UTC instant of that Monday's midnight, corrected by the zone's offset near `near`.
  const utcMidnight = Date.parse(`${week}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(near));
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offset = wallAsUtc - Math.floor(near / 60_000) * 60_000;
  return utcMidnight - offset;
}

/** A session's `open_my_week` answer, with the device's week when it was asked (re-review m-a). */
export interface AnsweredWeek {
  week: string;
  deviceWeek: string;
}

/**
 * The Monday (`YYYY-MM-DD`) of the week the SERVER is in for this account, from the snapshot's
 * newest goal (the server creates each week's goal in the account's zone, by `open_my_week` or by
 * settlement), or null when there is no goal for the server's week yet — the screen then falls back
 * to the device's week (final review m9). With D = the device's week, P = the week before it, and
 * G = the newest goal's `week_start`, and "the grace" = less than 26 h (`ZONE_SPREAD_MS`) since the
 * device's Monday began AND a snapshot fetched online (`offline` false, re-review m-c):
 * - `answered` (the session's `open_my_week` answer, `useCurrentWeekStart` passes it) is the server's
 *   own word, trusted only while the device is still in the week it asked in, or in the next week
 *   within the grace (re-review m-a): then the later of it and G. An older answer is ignored, so an
 *   app kept alive offline into a new week never keeps showing last week's goal.
 * - G >= D: G. The server made a goal for G, so it has reached G: a phone BEHIND the account zone.
 * - G = P within the grace: G. The server may still be in its Sunday: a phone AHEAD of the account
 *   zone. From the offline cache no grace: a same-zone phone offline on Monday says "appears when
 *   you're online" rather than show last week's goal.
 * - anything else (no goal, or an older one): null.
 */
export function currentServerWeekStart(
  snapshot: Pick<RewardsSnapshot, 'currentGoal'>,
  opts: { now?: number; zone?: string; answered?: AnsweredWeek; offline?: boolean } = {}
): string | null {
  const now = opts.now ?? Date.now();
  const zone = opts.zone ?? deviceZone();
  const d = isoWeekStart(dayKey(new Date(now), zone));
  const previous = new Date(Date.parse(`${d}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const grace = opts.offline !== true && now - weekBeganAt(d, zone, now) < ZONE_SPREAD_MS;
  const g = snapshot.currentGoal?.week_start ?? null;
  const answered = opts.answered;
  if (answered !== undefined && (answered.deviceWeek === d || (answered.deviceWeek === previous && grace))) {
    return g !== null && g > answered.week ? g : answered.week;
  }
  if (g === null) return null;
  if (g >= d) return g;
  if (g === previous && grace) return g;
  return null;
}

/**
 * `currentServerWeekStart` for the signed-in account, refined by this session's `open_my_week`
 * answer; re-renders when a new answer arrives. `undefined` until the rewards snapshot has loaded;
 * `null` when there is no goal for the server's week yet (fall back to the device's week).
 */
export function useCurrentWeekStart(deps: RewardsDeps = {}): string | null | undefined {
  const { now } = useDataSource();
  const uid = useSession().session?.user.id ?? null;
  const rewards = useRewards(deps);
  const answered = useSyncExternalStore(
    subscribeServerWeek,
    () => (uid === null ? undefined : serverWeeks.get(uid)),
    () => undefined
  );
  const data = rewards.data;
  if (data === undefined) return undefined;
  return currentServerWeekStart(data.snapshot, { now: now(), answered, offline: data.offline });
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
        noteServerWeek(uid, { week: answer.week_start, deviceWeek: attempt.deviceWeek });
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
