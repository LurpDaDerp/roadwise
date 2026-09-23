import { useLocalSearchParams } from 'expo-router';

import { ShareComposerScreen } from '@/features/share/ShareComposerScreen';

/**
 * `/rewards/share?kind=…` — F9's composer, presented as a sheet (`app/(app)/_layout.tsx`). The
 * params are validated by the screen: `kind` is one of trip, streak, badge, level or goal, with
 * `clientTripId` for a drive (D1 and D2 link here) or `badgeId` for a badge (F3).
 */
export default function ShareRoute() {
  const params = useLocalSearchParams<{ kind?: string; clientTripId?: string; badgeId?: string }>();
  return <ShareComposerScreen params={params} />;
}
