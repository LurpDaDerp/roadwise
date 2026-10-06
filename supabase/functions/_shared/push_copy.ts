// The three pushes v3 sends (plan §4 "Push/outbox"): what each inbox payload must hold, how
// long it stays worth sending, and the words. Copy is plain, short, second person; it never names
// another user (a friend request says only that one arrived) and never states a speed.
import { z } from 'zod';

export const PUSH_KINDS = ['weekly_recap', 'league_result', 'friend_request'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

const DAY_MS = 86_400_000;

/** How long after creation an item is still worth pushing; older is skipped as `stale`. */
export const TTL_MS: Record<PushKind, number> = {
  weekly_recap: 2 * DAY_MS,
  league_result: 3 * DAY_MS,
  friend_request: 7 * DAY_MS,
};

/** Where a tap lands (plan §7). */
export const URLS: Record<PushKind, string> = {
  weekly_recap: '/home',
  league_result: '/leagues',
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
    .loose(),
  league_result: z
    .object({
      week: z.string(),
      result: z.enum(['promoted', 'stayed', 'demoted']),
      final_rank: z.number().int().min(1),
      tier: z.string(),
      new_tier: z.string(),
      week_points: z.number().int(),
    })
    .loose(),
  friend_request: z.object({}).loose(),
};

export interface PushCopy {
  title: string;
  body: string;
  url: string;
}

export const isPushKind = (kind: string): kind is PushKind => (PUSH_KINDS as readonly string[]).includes(kind);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The words for one item, or null when the payload is not what the kind needs (nothing true to say). */
export function renderPush(kind: PushKind, payload: unknown): PushCopy | null {
  if (kind === 'weekly_recap') {
    const p = PayloadSchemas.weekly_recap.safeParse(payload);
    if (!p.success) return null;
    const { rating, rating_delta, streak, drives, week_points } = p.data;
    const ratingPart =
      rating === null
        ? 'Not ranked yet.'
        : rating_delta === null || Math.abs(rating_delta) < 0.05
          ? `Safety Rating ${rating.toFixed(1)}.`
          : `Safety Rating ${rating.toFixed(1)} (${rating_delta > 0 ? 'up' : 'down'} ${Math.abs(rating_delta).toFixed(1)}).`;
    return {
      title: 'Your week in review',
      body: `${plural(drives, 'drive', 'drives')}, ${week_points >= 0 ? '+' : ''}${week_points} points. ${ratingPart} Streak ${streak}.`,
      url: URLS.weekly_recap,
    };
  }
  if (kind === 'league_result') {
    const p = PayloadSchemas.league_result.safeParse(payload);
    if (!p.success) return null;
    const { result, final_rank, tier, new_tier } = p.data;
    const body =
      result === 'promoted'
        ? `You finished #${final_rank} in ${cap(tier)} and moved up to ${cap(new_tier)}.`
        : result === 'demoted'
          ? `You finished #${final_rank} in ${cap(tier)}. Next week starts in ${cap(new_tier)}.`
          : `You finished #${final_rank} in ${cap(tier)}. A new week starts now.`;
    return { title: 'League results are in', body, url: URLS.league_result };
  }
  const p = PayloadSchemas.friend_request.safeParse(payload);
  if (!p.success) return null;
  return { title: 'New friend request', body: 'Someone wants to add you as a friend.', url: URLS.friend_request };
}
