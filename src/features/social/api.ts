/**
 * Friends, profiles, blocks and reports over the v3 RPCs (`.agent/v3/backend-interface.md` §5,
 * `supabase/migrations/0006_social.sql`). Reads are focus-aware server queries; every write goes
 * through `useServerAction`, which invalidates the server queries that write moves after it lands.
 */
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { callRpc } from '@/data/server/rpc';
import { invalidateAfterWrite } from '@/data/server/invalidate';
import type { LeagueTier } from '@/data/server/summary';
import { SERVER_SLOW_STALE_MS, useServerQuery } from '@/data/server/useServerQuery';
import type { StatSums } from '@scoring';

import { friendlyError } from './errors';
import { USERNAME_RE } from './links';

/** `private.public_card`: what anyone allowed to see a driver sees. */
export interface PublicCard {
  user_id: string;
  username: string;
  level: number;
  safety_rating: number | null;
  ranked: boolean;
  league_tier: LeagueTier;
  streak: number;
}

export type Relationship = 'self' | 'friend' | 'incoming' | 'outgoing' | 'none';

export interface PublicProfile extends PublicCard {
  achievements: string[];
  clan: { id: string; name: string } | null;
  relationship: Relationship;
  can_view_stats: boolean;
  can_view_heatmap: boolean;
}

export interface FriendsList {
  friends: PublicCard[];
  incoming: PublicCard[];
  outgoing: PublicCard[];
}

export interface SearchResult {
  user_id: string;
  username: string;
  level: number;
  safety_rating: number | null;
}

export interface BlockedUser {
  user_id: string;
  username: string;
}

export type ReportReason = 'inappropriate_name' | 'harassment' | 'cheating' | 'impersonation' | 'other';
export const REPORT_REASONS: readonly ReportReason[] = [
  'inappropriate_name',
  'harassment',
  'cheating',
  'impersonation',
  'other',
];

export function useProfile(username: string): UseQueryResult<PublicProfile> {
  const name = username.toLowerCase();
  return useServerQuery<PublicProfile>(['profile', name], 'get_profile', { p_username: name }, {
    enabled: USERNAME_RE.test(name),
    staleMs: SERVER_SLOW_STALE_MS,
  });
}

export function useFriends(opts: { enabled?: boolean } = {}): UseQueryResult<FriendsList> {
  return useServerQuery<FriendsList>(['friends'], 'list_friends', undefined, opts);
}

export function useBlocked(): UseQueryResult<BlockedUser[]> {
  return useServerQuery<BlockedUser[]>(['blocked'], 'list_blocked', undefined, { staleMs: SERVER_SLOW_STALE_MS });
}

/** Normalised search text, or null when it is too short or has characters no username has. */
export function searchQuery(text: string): string | null {
  const q = text.trim().toLowerCase();
  return q.length >= 3 && q.length <= 20 && /^[a-z0-9_]+$/.test(q) ? q : null;
}

export function useSearchUsers(query: string | null): UseQueryResult<SearchResult[]> {
  return useServerQuery<SearchResult[]>(['search', query], 'search_users', { p_query: query }, {
    enabled: query !== null,
  });
}

export function useMemberStats(userId: string | null, enabled: boolean): UseQueryResult<StatSums> {
  return useServerQuery<StatSums>(['memberStats', userId], 'get_member_stats', { p_user_id: userId }, {
    enabled: enabled && userId !== null,
    staleMs: SERVER_SLOW_STALE_MS,
  });
}

export function useHeatmap(userId: string | null, enabled: boolean): UseQueryResult<{ polyline: string }[]> {
  return useServerQuery<{ polyline: string }[]>(['heatmap', userId], 'get_heatmap', { p_user_id: userId }, {
    enabled: enabled && userId !== null,
    staleMs: SERVER_SLOW_STALE_MS,
  });
}

export interface ServerAction {
  /** Calls `fn`; resolves true on success (after the cache is invalidated), false on failure. */
  run: (fn: string, args?: Record<string, unknown>) => Promise<boolean>;
  /** The RPC in flight, so a screen can mark the one button that is busy. */
  pending: string | null;
  error: string | null;
  clearError: () => void;
}

/**
 * One write at a time: a second tap while one is in flight is ignored. A failure keeps the screen
 * as it was and sets `error` to friendly copy.
 */
export function useServerAction(): ServerAction {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (fn: string, args?: Record<string, unknown>) => {
      if (busy.current) return false;
      busy.current = true;
      setPending(fn);
      setError(null);
      try {
        await callRpc<unknown>(fn, args);
        await invalidateAfterWrite(qc, fn);
        return true;
      } catch (e) {
        setError(friendlyError(e));
        return false;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [qc]
  );

  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}
