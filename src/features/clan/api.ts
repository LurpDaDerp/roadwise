/**
 * Clan reads and writes (`.agent/v3/backend-interface.md` §5, `supabase/migrations/0006_social.sql`).
 * Every write invalidates the server queries it moves afterwards (`invalidateAfterWrite`): a clan
 * change moves the clan, its preview, the friends board and members' profiles.
 */
import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';

import { callRpc } from '@/data/server/rpc';
import { invalidateAfterWrite } from '@/data/server/invalidate';
import { SERVER_SLOW_STALE_MS, useServerQuery } from '@/data/server/useServerQuery';

import type { ClanBanner, ClanRole } from './types';

export { CLAN_BANNERS, type ClanBanner, type ClanRole, type ReportReason } from './types';

export interface ClanMember {
  user_id: string;
  username: string;
  role: ClanRole;
  joined_at: string;
  level: number;
  safety_rating: number | null;
  ranked: boolean;
  points: number;
  week_points: number;
  miles_30d: number;
  /** Null with no scored drives in 30 days. */
  clean_pct: number | null;
  streak: number;
}

export interface MyClan {
  clan: {
    id: string;
    name: string;
    banner: ClanBanner;
    /** Only the leader and co-leaders see it. */
    invite_code: string | null;
    member_count: number;
  };
  my_role: ClanRole;
  goal: { week: string; target_clean_miles: number; clean_miles: number };
  /** Blocked users omitted. */
  members: ClanMember[];
}

export interface ClanPreview {
  name: string;
  banner: ClanBanner;
  member_count: number;
  full: boolean;
}

/** `null` when you're not in a clan. */
export function useMyClan(): UseQueryResult<MyClan | null> {
  return useServerQuery<MyClan | null>(['clan'], 'get_my_clan', undefined, { staleMs: SERVER_SLOW_STALE_MS });
}

export function useClanPreview(code: string | null): UseQueryResult<ClanPreview> {
  return useServerQuery<ClanPreview>(['clan-preview', code], 'preview_clan', { p_code: code }, { enabled: code !== null });
}

/** A server write that refreshes the server queries it moves once it lands. */
export function useServerAction<A extends Record<string, unknown> | void, R = unknown>(
  fn: string
): UseMutationResult<R, Error, A> {
  const qc = useQueryClient();
  return useMutation<R, Error, A>({
    mutationFn: (args: A) => callRpc<R>(fn, (args ?? {}) as Record<string, unknown>),
    onSuccess: () => invalidateAfterWrite(qc, fn),
  });
}
