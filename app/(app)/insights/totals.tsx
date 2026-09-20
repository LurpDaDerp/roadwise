import { useLocalSearchParams, useRouter } from 'expo-router';

import { parsePeriod, TotalsScreen } from '@/features/insights';

/**
 * E3 — `/(app)/insights/totals`. Opened without a period it shows all time: a record is a
 * lifetime thing, where the overview is about the last few weeks.
 */
export default function TotalsRoute() {
  const router = useRouter();
  const { period } = useLocalSearchParams<{ period?: string }>();
  return (
    <TotalsScreen
      period={parsePeriod(period, 'all')}
      onPeriodChange={(next) => router.setParams({ period: next })}
    />
  );
}
