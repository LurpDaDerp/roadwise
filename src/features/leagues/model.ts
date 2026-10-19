/** Pure view logic for the Leaderboards tab: rating text and the friends board order. No React. */
import { formatRating } from '@/lib/rating';

import type { FriendsBoardRow, FriendsMetric } from './api';

// ---------------------------------------------------------------------------
// numbers and words
// ---------------------------------------------------------------------------

export { UNRANKED } from '@/lib/rating';

/** A Safety Rating, never shown for an unranked driver (under 25 mi in 30 days): the shared rule. */
export const ratingText = (rating: number | null, ranked: boolean): string => formatRating(rating, ranked);

export function percentileText(percentile: number): string {
  return `You're in the top ${percentile}%`;
}

export function rankText(rank: number): string {
  return `#${rank.toLocaleString('en-US')}`;
}

export interface RankedFriendRow extends Omit<FriendsBoardRow, 'rank'> {
  /** Null for an unranked driver on the rating board: they are listed, not placed. */
  rank: number | null;
}

/**
 * The friends board as shown. Week points keep the server's order. On the rating board an
 * unranked driver's number is a few miles of noise, so ranked drivers come first by rating (ties
 * by username, as the server does) and unranked ones follow, alphabetical, with no place.
 */
export function rankFriendsBoard(rows: readonly FriendsBoardRow[], metric: FriendsMetric): RankedFriendRow[] {
  if (metric === 'week') return [...rows].sort((a, b) => a.rank - b.rank);
  const byName = (a: FriendsBoardRow, b: FriendsBoardRow) => a.username.localeCompare(b.username);
  const ranked = rows
    .filter((r) => r.ranked && r.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byName(a, b))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const unranked = rows
    .filter((r) => !(r.ranked && r.value !== null))
    .sort(byName)
    .map((r) => ({ ...r, rank: null }));
  return [...ranked, ...unranked];
}
