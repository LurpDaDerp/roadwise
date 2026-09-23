import { useLocalSearchParams } from 'expo-router';

import { JoinScreen } from '@/features/referral/JoinScreen';

/**
 * `roadwise://join/<code>` — a friend's invite link. The screen validates the param itself and
 * asks before using the code; M4's gate holds and replays this link through onboarding
 * (`JOIN_HREF` in the one allowlist).
 */
export default function JoinRoute() {
  const { code } = useLocalSearchParams<{ code?: string | string[] }>();
  return <JoinScreen code={code} />;
}
