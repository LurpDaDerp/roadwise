/**
 * React Query over a server RPC, for data only the server has (summary, boards, clan, friends).
 *
 * Keys are scoped by the signed-in user so a different account never paints the last one's
 * cache. The app's QueryClient never refetches on focus (its local-SQLite queries don't need it),
 * so this refetches stale data when the screen gains focus and, if `pollMs` is set, polls only
 * while the screen stays focused and the app is active — a backgrounded tab or app costs no
 * requests. `keepPrevious` keeps the last data on screen while a changed key (filter) loads.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useSession } from '@/data/supabase/session';

import { callRpc } from './rpc';

/** Server data is served from cache for this long before a focus refetches it. */
export const SERVER_STALE_MS = 60_000;
/** For data that changes rarely or only through this phone's own writes (which invalidate it). */
export const SERVER_SLOW_STALE_MS = 10 * 60_000;

export function serverKey(uid: string | null, ...parts: unknown[]): unknown[] {
  return ['server', uid, ...parts];
}

export function useServerQuery<T>(
  key: unknown[],
  fn: string,
  args?: Record<string, unknown>,
  opts: { pollMs?: number; enabled?: boolean; keepPrevious?: boolean; staleMs?: number } = {}
): UseQueryResult<T> {
  const { session } = useSession();
  const uid = session?.user.id ?? null;
  const [focused, setFocused] = useState(true);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  const query = useQuery<T>({
    queryKey: serverKey(uid, ...key),
    queryFn: () => callRpc<T>(fn, args),
    enabled: uid !== null && (opts.enabled ?? true),
    staleTime: opts.staleMs ?? SERVER_STALE_MS,
    retry: 1,
    placeholderData: opts.keepPrevious ? keepPreviousData : undefined,
    // A backgrounded app or an unfocused screen never polls.
    refetchInterval: focused && appActive && opts.pollMs ? opts.pollMs : false,
  });
  // Read through a ref so the focus callback runs on focus only — not again each time the data
  // turns stale while the screen is showing, which would quietly poll every query.
  const latest = useRef(query);
  useEffect(() => {
    latest.current = query;
  });
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      // `cancelRefetch: false` joins a fetch already in flight (the mount fetch) instead of
      // aborting and restarting it — `callRpc` can't abort, so a restart sent a second request.
      if (latest.current.isStale) void latest.current.refetch({ cancelRefetch: false });
      return () => setFocused(false);
    }, [])
  );
  return query;
}
