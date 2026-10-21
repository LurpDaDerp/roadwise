/** Pure view logic for the Friends tab: rating text and the board's order. No React. */
import { formatRating } from '@/lib/rating';

import type { FriendsBoardRow } from './api';

export { UNRANKED } from '@/lib/rating';

/** A Safety Rating, never shown for a driver without one (under 10 mi in 90 days): the shared rule. */
export const ratingText = (rating: number | null, ranked: boolean): string => formatRating(rating, ranked);

export interface RankedFriendRow extends Omit<FriendsBoardRow, 'rank'> {
  /** Null for a driver without a rating: listed, not placed. */
  rank: number | null;
}

/**
 * The friends board as shown: ranked drivers first by Safety Rating (ties by username, as the
 * server does), then those without a rating yet, alphabetical, with no place (their number is a
 * few miles of noise).
 */
export function rankFriendsBoard(rows: readonly FriendsBoardRow[]): RankedFriendRow[] {
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
