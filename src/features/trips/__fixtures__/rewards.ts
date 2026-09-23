/**
 * The rewards server the trip screens talk to, for their suites (M5 Task 11). Each suite mocks
 * `@/features/rewards/api` so its `defaultRewardsApi` is `rewardsApiDelegate`, and points
 * `rewardsServer` at a fresh `fakeScreensApi` (Task 9's double) in `beforeEach`:
 *
 *   jest.mock('@/features/rewards/api', () => ({
 *     ...jest.requireActual('@/features/rewards/api'),
 *     defaultRewardsApi: jest.requireActual('@/features/trips/__fixtures__/rewards').rewardsApiDelegate,
 *   }));
 *
 * The suites also mock `@/data/supabase/client` and `@/data/supabase/session` (the rewards hooks
 * read the session), as every rewards screen suite does.
 */
import type { RewardsApi, RewardsSnapshot } from '@/features/rewards/api';
import { fakeScreensApi } from '@/features/rewards/__fixtures__/goalChallengesWorld';
import { progressRow, rewardDayRow, snapshot } from '@/features/rewards/__fixtures__/rows';

export const rewardsServer: { current: ReturnType<typeof fakeScreensApi> | null } = { current: null };

const api = (): RewardsApi => {
  if (rewardsServer.current === null) throw new Error('rewardsServer.current is not set');
  return rewardsServer.current.api;
};

export const rewardsApiDelegate: RewardsApi = {
  fetchSnapshot: () => api().fetchSnapshot(),
  fetchRewardDay: (day) => api().fetchRewardDay(day),
  openMyWeek: () => api().openMyWeek(),
  setWeeklyFocus: (category) => api().setWeeklyFocus(category),
  joinChallenge: (defId) => api().joinChallenge(defId),
  leaveChallenge: (id) => api().leaveChallenge(id),
};

/** The trip fixtures' day (`T0`, 2026-01-05) as the rewards know it. */
export const TRIP_DAY = '2026-01-05';

/** Rewards began before the drive and the frontier has not reached its day: the day is pending. */
export const pendingDay = (): RewardsSnapshot =>
  snapshot({
    progress: progressRow({ rewards_start: '2026-01-01', settled_through: '2026-01-04' }),
    days: [rewardDayRow('2026-01-04', { streak_after: 4 })],
  });

/** The drive's day has settled with `over` (by default a safe, phone-free day: 75 points). */
export const settledDay = (over: Parameters<typeof rewardDayRow>[1] = {}): RewardsSnapshot =>
  snapshot({
    progress: progressRow({ rewards_start: '2026-01-01', settled_through: TRIP_DAY }),
    days: [rewardDayRow(TRIP_DAY, { streak_after: 5, ...over })],
  });

/** Rewards began after the drive's day: it is not part of them and never will be. */
export const beforeRewardsDay = (): RewardsSnapshot =>
  snapshot({ progress: progressRow({ rewards_start: '2026-02-01', settled_through: '2026-02-03' }), days: [] });

/** Point the delegate at a fresh server double holding `initial`. */
export function serveRewards(initial: RewardsSnapshot) {
  rewardsServer.current = fakeScreensApi(initial);
  return rewardsServer.current;
}
