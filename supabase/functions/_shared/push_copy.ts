// The pushes RoadWise sends (plan §4 "Push/outbox"): what each inbox payload must hold, how long
// it stays worth sending, and the words. Copy is plain, short, second person; it never names
// another user (a friend request says only that one arrived) and never states a speed.
//
// The app has no leagues: a `league_result` the database still queues is not a kind here, so
// push-sender skips it (`unknown_type`), and the weekly recap says nothing about a league.
import { z } from 'zod';

export const PUSH_KINDS = ['weekly_recap', 'friend_request'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

const DAY_MS = 86_400_000;

/** How long after creation an item is still worth pushing; older is skipped as `stale`. */
export const TTL_MS: Record<PushKind, number> = {
  weekly_recap: 2 * DAY_MS,
  friend_request: 7 * DAY_MS,
};

/** Where a tap lands (plan §7). */
export const URLS: Record<PushKind, string> = {
  weekly_recap: '/home',
  friend_request: '/friends',
};

export const ANDROID_CHANNEL = 'updates';

export const PayloadSchemas = {
  weekly_recap: z
    .object({
      week: z.string(),
      rating: z.number().nullable(),
      rating_delta: z.number().nullable(),
      streak: z.number().int().min(0),
      drives: z.number().int().min(0),
      week_points: z.number().int(),
      best_drive_net: z.number().int().nullable(),
    })
    // Extra fields (the league rank the database still adds) are allowed and never said.
    .loose(),
  friend_request: z.object({}).loose(),
};

export interface PushCopy {
  title: string;
  body: string;
  url: string;
}

export const isPushKind = (kind: string): kind is PushKind => (PUSH_KINDS as readonly string[]).includes(kind);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The words for one item, or null when the payload is not what the kind needs (nothing true to say). */
export function renderPush(kind: PushKind, payload: unknown): PushCopy | null {
  if (kind === 'weekly_recap') {
    const p = PayloadSchemas.weekly_recap.safeParse(payload);
    if (!p.success) return null;
    const { rating, rating_delta, streak, drives, week_points, best_drive_net } = p.data;
    const ratingPart =
      rating === null
        ? 'Not ranked yet.'
        : rating_delta === null || Math.round(Math.abs(rating_delta)) === 0
          ? `Safety Rating ${Math.round(rating)}.`
          : `Safety Rating ${Math.round(rating)} (${rating_delta > 0 ? 'up' : 'down'} ${Math.round(Math.abs(rating_delta))}).`;
    const bestPart = best_drive_net === null || best_drive_net === undefined ? '' : ` Best drive ${best_drive_net >= 0 ? '+' : ''}${best_drive_net}.`;
    return {
      title: 'Your week in review',
      body: `${plural(drives, 'drive', 'drives')}, ${week_points >= 0 ? '+' : ''}${week_points} points.${bestPart} ${ratingPart} Streak ${streak}.`,
      url: URLS.weekly_recap,
    };
  }
  const p = PayloadSchemas.friend_request.safeParse(payload);
  if (!p.success) return null;
  return { title: 'New friend request', body: 'Someone wants to add you as a friend.', url: URLS.friend_request };
}
