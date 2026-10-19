/**
 * The two boards on the Leaderboards tab, read from the server (`.agent/v3/backend-interface.md`
 * §5, `supabase/migrations/0007_leagues.sql`). Both refresh on focus and on pull.
 */
import type { UseQueryResult } from '@tanstack/react-query';

import { SERVER_SLOW_STALE_MS, useServerQuery } from '@/data/server/useServerQuery';

export type FriendsMetric = 'week' | 'rating';

export interface FriendsBoardRow {
  rank: number;
  user_id: string;
  username: string;
  level: number;
  /** Week points, or the Safety Rating (null with no miles). */
  value: number | null;
  ranked: boolean;
  is_me: boolean;
}

export interface GlobalBoard {
  top: {
    rank: number;
    user_id: string;
    username: string;
    safety_rating: number;
    clean_miles: number;
  }[];
  me: {
    rank: number | null;
    percentile: number | null;
    eligible: boolean;
    safety_rating: number | null;
  };
}

export function useFriendsBoard(metric: FriendsMetric): UseQueryResult<FriendsBoardRow[]> {
  return useServerQuery<FriendsBoardRow[]>(['friends-board', metric], 'get_friends_board', { p_metric: metric }, {
    keepPrevious: true,
  });
}

export function useGlobalBoard(state: string | null): UseQueryResult<GlobalBoard> {
  return useServerQuery<GlobalBoard>(['global-board', state], 'get_global_board', { p_state: state }, {
    keepPrevious: true,
    staleMs: SERVER_SLOW_STALE_MS,
  });
}
