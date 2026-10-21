import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useDashpalChip } from '@/dashcam/ui/HudDashpal';
import { useMySummary } from '@/data/server/summary';
import { driveSummaryHref } from '@/features/drives/routes';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { AnalyticsView } from './AnalyticsView';
import type { Range } from './model';
import { useAnalytics } from './useAnalytics';

/**
 * The Analytics tab: local drives through `useAnalytics` (the radar's centre is their 30-day
 * Safety Rating), and the points total now from the server for the Trends card's latest point.
 */
export function AnalyticsScreen() {
  const router = useRouter();
  const [range, setRange] = useState<Range>('week');
  const summary = useMySummary();
  const data = useAnalytics(range, { pointsNow: summary.data?.progress.points ?? null });
  const { rating } = data.coaching;
  const dashpalPaired = useDashpalChip() !== null;
  return (
    <AnalyticsView
      data={data}
      // Unranked (under 10 mi in 30 days) reads "—" here as it does on Home and Profile.
      rating={rating.ranked ? rating.rating : null}
      range={range}
      onRange={setRange}
      onOpenDrive={(id) => router.push(driveSummaryHref(id))}
      dashpalPaired={dashpalPaired}
      onPairDashpal={() => router.push(SETTINGS_HREFS.dashcam)}
    />
  );
}
