/**
 * The onboarding flow's context, from what the phone already knows: the session's profile (the
 * network row, or the cached one after an offline cold start). It never waits on the network.
 */
import { useMemo } from 'react';
import { Platform } from 'react-native';

import { useSession } from '@/data/supabase/session';

import type { FlowContext } from './flow';

/** The pure part. Read loosely: the profile row's generated type is being rebuilt. */
export function buildFlowContext(input: { platform: 'ios' | 'android'; profile: unknown }): FlowContext {
  const profile =
    typeof input.profile === 'object' && input.profile !== null
      ? (input.profile as Record<string, unknown>)
      : {};
  const username = profile.username;
  return {
    platform: input.platform,
    hasUsername: typeof username === 'string' && username.trim().length > 0,
  };
}

/** The stepper's context, or null while the profile is still being read. */
export function useFlowContext(): FlowContext | null {
  const { profile } = useSession();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  return useMemo(
    () => (profile === null ? null : buildFlowContext({ platform, profile })),
    [profile, platform]
  );
}
