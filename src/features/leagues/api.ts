/**
 * The Friends tab's board, read from the server (`public.get_friends_board()`): you and the
 * friends who share their Safety Rating with you. It refreshes on focus and on pull.
 */
import type { UseQueryResult } from '@tanstack/react-query';

import { useServerQuery } from '@/data/server/useServerQuery';

export interface FriendsBoardRow {
  rank: number;
  user_id: string;
  username: string;
  /** The Safety Rating; null with no miles in the 90 days. */
  value: number | null;
  ranked: boolean;
  is_me: boolean;
  /** Miles in the last 90 days; null unless it is you or a friend who shares their driving stats. */
  miles_90d: number | null;
}

export function useFriendsBoard(): UseQueryResult<FriendsBoardRow[]> {
  return useServerQuery<FriendsBoardRow[]>(['friends-board'], 'get_friends_board', undefined);
}
