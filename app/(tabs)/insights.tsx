import { useLocalSearchParams, useRouter } from 'expo-router';

import { InsightsOverviewScreen, parsePeriod } from '@/features/insights';

/**
 * E1 in the tab bar — the door to Insights.
 *
 * The same screen the pushed `/(app)/insights` route renders, so a deep link and the tab show one
 * overview rather than two that can drift. `bottomInset={false}` because the tab bar sits between
 * this screen and the home indicator and pads itself; and `TopBar` draws no Back here, since a tab
 * root has nothing to go back to — which is correct. E2, E3 and E4 are pushed over the tabs from
 * here, and carry the period with them.
 */
export default function InsightsTab() {
  const router = useRouter();
  const { period } = useLocalSearchParams<{ period?: string }>();
  return (
    <InsightsOverviewScreen
      period={parsePeriod(period)}
      onPeriodChange={(next) => router.setParams({ period: next })}
      bottomInset={false}
    />
  );
}
