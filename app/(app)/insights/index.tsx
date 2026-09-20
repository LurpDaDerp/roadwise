import { useLocalSearchParams, useRouter } from 'expo-router';

import { InsightsOverviewScreen, parsePeriod } from '@/features/insights';

/**
 * E1 — `/(app)/insights`, the overview.
 *
 * The period lives in the query string rather than in component state, so the selection survives
 * a push into a category and a swipe back, and a shared link names the window it was read over.
 */
export default function InsightsRoute() {
  const router = useRouter();
  const { period } = useLocalSearchParams<{ period?: string }>();
  return (
    <InsightsOverviewScreen
      period={parsePeriod(period)}
      onPeriodChange={(next) => router.setParams({ period: next })}
    />
  );
}
