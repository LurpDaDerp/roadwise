/**
 * The rewards query keys. Every rewards query sits under `REWARDS_QUERY_KEY` (`['rewards']`, M4
 * Task 4), so the notification host's invalidate-on-receipt reaches all of them, and each carries
 * the signed-in uid, so one account's rewards are never served to the next.
 */
import { REWARDS_QUERY_KEY } from '@/notifications/keys';

export { REWARDS_QUERY_KEY };

/** How long fetched rewards are served before a mount or a foreground fetches again. */
export const REWARDS_STALE_MS = 5 * 60_000;

/** The snapshot: `['rewards', uid]`. */
export const rewardsKey = (uid: string) => [...REWARDS_QUERY_KEY, uid] as const;

/** One settled day outside the snapshot: `['rewards', 'day', uid, day]`. */
export const rewardDayKey = (uid: string, day: string) => [...REWARDS_QUERY_KEY, 'day', uid, day] as const;
