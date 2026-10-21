// The pushes RoadWise sends: what each inbox payload must hold, how long it stays worth sending,
// and the words. Copy is plain, short, second person; it never names another user (a friend
// request says only that one arrived) and never states a speed. Any other kind is skipped
// (`unknown_type`).
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
      drives: z.number().int().min(0),
      /** Weekly goals done that week; absent on a recap queued before 0023 (the goals part is left out). */
      goals_done: z.number().int().min(0).max(3).optional(),
    })
    // Extra fields (an older recap's points and streak) are allowed and never said.
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
    const { rating, rating_delta, drives, goals_done } = p.data;
    const drivesPart = `${plural(drives, 'drive', 'drives')} this week.`;
    const d = rating_delta === null ? 0 : Math.round(rating_delta);
    const ratingPart =
      rating === null ? ' Your Safety Rating is on its way.' : ` Safety Rating ${Math.round(rating)}${d > 0 ? `, up ${d}` : d < 0 ? `, down ${-d}` : ''}.`;
    const goalsPart = !goals_done ? '' : goals_done >= 3 ? ' All 3 weekly goals done.' : ` ${goals_done} of 3 weekly goals done.`;
    return { title: 'Your week on the road', body: `${drivesPart}${ratingPart}${goalsPart}`, url: URLS.weekly_recap };
  }
  const p = PayloadSchemas.friend_request.safeParse(payload);
  if (!p.success) return null;
  return { title: 'New friend request', body: 'Someone wants to add you as a friend.', url: URLS.friend_request };
}
