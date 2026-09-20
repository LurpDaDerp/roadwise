import { useLocalSearchParams, useRouter } from 'expo-router';

import { CategoryScreen, parseCategory, parsePeriod } from '@/features/insights';

/** E2 — `/(app)/insights/<category>`, one behaviour end to end. */
export default function CategoryRoute() {
  const router = useRouter();
  const { category, period } = useLocalSearchParams<{ category?: string; period?: string }>();
  return (
    <CategoryScreen
      category={parseCategory(category)}
      period={parsePeriod(period)}
      onPeriodChange={(next) => router.setParams({ period: next })}
    />
  );
}
