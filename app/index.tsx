import { Redirect } from 'expo-router';

import { useSession } from '@/data/supabase/session';
import { resolveStart } from '@/features/auth/authGuard';
import { Screen, Skeleton } from '@/ui';

/** A1: the launch router. It draws a held frame, never a screen, and then hands off. */
export default function Launch() {
  const { status, profile } = useSession();
  const flags = profile?.flags as { onboarded?: boolean } | null | undefined;
  const to = resolveStart(status, flags?.onboarded === true);

  // The stored session is still being read. A skeleton field, not a spinner: the shape of the
  // licence is already on screen when the first real screen arrives.
  if (!to) {
    return (
      <Screen>
        <Skeleton width={160} height={24} />
      </Screen>
    );
  }

  // Onboarding routes arrive in M4; until then a signed-in driver lands on Home.
  return <Redirect href={to === '/(onboarding)' ? '/(tabs)/home' : to} />;
}
