import { useRouter, useSegments } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { useSession } from '@/data/supabase/session';

import { resolveGate } from './authGuard';

/**
 * The route guard. `app/index.tsx` only decides where a cold start lands; this watches `status`
 * for the whole life of the app, so signing in moves the driver into the tabs, signing out moves
 * them back to Welcome, and a session that arrives on a deep link does not leave anyone on the
 * callback screen. It renders its children untouched — the navigation is the whole effect.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const to = resolveGate(status, segments);
    if (to) router.replace(to);
  }, [status, segments, router]);

  return <>{children}</>;
}
