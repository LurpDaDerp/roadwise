/**
 * React Query over a server RPC, for data only the server has (summary, boards, clan, friends).
 *
 * Keys are scoped by the signed-in user so a different account never paints the last one's
 * cache. The app's QueryClient never refetches on focus (its local-SQLite queries don't need it),
 * so this refetches stale data when the screen gains focus and, if `pollMs` is set, polls only
 * while the screen stays focused — a backgrounded tab costs no requests.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useSession } from '@/data/supabase/session';

import { callRpc } from './rpc';

/** Server data is served from cache for this long before a focus refetches it. */
export const SERVER_STALE_MS = 60_000;

export function serverKey(uid: string | null, ...parts: unknown[]): unknown[] {
  return ['server', uid, ...parts];
}

export function useServerQuery<T>(
  key: unknown[],
  fn: string,
  args?: Record<string, unknown>,
  opts: { pollMs?: number; enabled?: boolean } = {}
): UseQueryResult<T> {
  const { session } = useSession();
  const uid = session?.user.id ?? null;
  const [focused, setFocused] = useState(true);
  const query = useQuery<T>({
    queryKey: serverKey(uid, ...key),
    queryFn: () => callRpc<T>(fn, args),
    enabled: uid !== null && (opts.enabled ?? true),
    staleTime: SERVER_STALE_MS,
    retry: 1,
    refetchInterval: focused && opts.pollMs ? opts.pollMs : false,
  });
  const { refetch, isStale } = query;
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (isStale) void refetch();
      return () => setFocused(false);
    }, [isStale, refetch])
  );
  return query;
}
