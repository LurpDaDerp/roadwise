/**
 * The three boards on the Leagues tab, read from the server (`.agent/v3/backend-interface.md` §5,
 * `supabase/migrations/0007_leagues.sql`). Only the league board polls, and only while the tab is
 * focused: points move during the week as drives land. The other two refresh on focus and on pull.
 */
import type { UseQueryResult } from '@tanstack/react-query';

import type { LeagueTier } from '@/data/server/summary';
import { useServerQuery } from '@/data/server/useServerQuery';

export type { LeagueTier };

export interface LeagueMember {
  rank: number;
  user_id: string;
  username: string;
  level: number;
  week_points: number;
  drives: number;
  is_me: boolean;
}

export interface MyLeague {
  /** League week key, `IYYY-Www` (America/New_York). */
  week: string;
  /** ISO timestamp of next Monday 00:00 New York. */
  ends_at: string;
  tier: LeagueTier;
  /** False when this phone's league slot belongs to another account. */
  eligible: boolean;
  placed: boolean;
  group_id: string | null;
  /** Standings, blocked users omitted (so ranks can skip). Empty when unplaced. */
  members: LeagueMember[];
  /** Group size on the server, blocked users included: the demotion zone counts from it. */
  size: number;
  promote: number;
  demote: number;
  min_drives_to_promote: number;
  last_result: {
    week: string;
    result: 'promoted' | 'stayed' | 'demoted';
    final_rank: number;
    /** The tier that week was played in. */
    tier: LeagueTier;
  } | null;
}

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

/** The league board polls once a minute while the tab is on screen (never faster). */
export const LEAGUE_POLL_MS = 60_000;

export function useMyLeague(): UseQueryResult<MyLeague> {
  return useServerQuery<MyLeague>(['league'], 'get_my_league', undefined, { pollMs: LEAGUE_POLL_MS });
}

export function useFriendsBoard(metric: FriendsMetric): UseQueryResult<FriendsBoardRow[]> {
  return useServerQuery<FriendsBoardRow[]>(['friends-board', metric], 'get_friends_board', { p_metric: metric });
}

export function useGlobalBoard(state: string | null): UseQueryResult<GlobalBoard> {
  return useServerQuery<GlobalBoard>(['global-board', state], 'get_global_board', { p_state: state });
}
