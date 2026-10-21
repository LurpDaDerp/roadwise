import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useMySummary } from '@/data/server/summary';
import { driveSummaryHref } from '@/features/drives/routes';

import { AnalyticsView } from './AnalyticsView';
import type { Range } from './model';
import { useAnalytics } from './useAnalytics';

/** The Analytics tab: local drives through `useAnalytics`, the Safety Rating from the server. */
export function AnalyticsScreen() {
  const router = useRouter();
  const [range, setRange] = useState<Range>('week');
  const data = useAnalytics(range);
  const summary = useMySummary();
  const progress = summary.data?.progress;
  return (
    <AnalyticsView
      data={data}
      // Unranked (under 10 mi in 30 days) reads "—" here as it does on Home and Profile.
      rating={progress?.ranked ? progress.safety_rating : null}
      range={range}
      onRange={setRange}
      onOpenDrive={(id) => router.push(driveSummaryHref(id))}
    />
  );
}
