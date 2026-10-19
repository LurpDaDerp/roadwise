import { Banner, Screen, SegmentedControl, Skeleton, useTheme } from '@/ui';

import { BestsCard } from './BestsCard';
import { analyticsCopy } from './copy';
import { DrivesCard } from './DrivesCard';
import { MetricsCards } from './MetricsCards';
import { RANGE_LABEL, RANGES, type Range } from './model';
import { RadarCard } from './RadarCard';
import { SummaryCard } from './SummaryCard';
import { TripsMapCard } from './TripsMapCard';
import type { AnalyticsData } from './useAnalytics';
import { WhenYouDriveCard } from './WhenYouDriveCard';

const SEGMENTS = RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }));

export interface AnalyticsViewProps {
  data: AnalyticsData;
  /** The server Safety Rating (`summary.progress.safety_rating`); null before it exists. */
  rating: number | null;
  range: Range;
  onRange: (range: Range) => void;
  onOpenDrive: (clientTripId: string) => void;
}

/**
 * The Analytics tab, top to bottom: the 30-day radar with the Safety Rating, the coaching line,
 * all-time bests, then the range toggle and everything it drives (metrics, when you drive, the
 * drives list), with the all-trips map (always all time) between them. Every card is paper.
 */
export function AnalyticsView({ data, rating, range, onRange, onOpenDrive }: AnalyticsViewProps) {
  const t = useTheme();
  const first = data.loading && data.drives.length === 0;
  return (
    <Screen sky scroll bottomInset={false} title={analyticsCopy.title} testID="analytics-screen">
      {data.error ? <Banner tone="warning" message={analyticsCopy.error} /> : null}
      {first ? (
        <>
          <Skeleton width="100%" height={340} radius={t.radius.card} testID="analytics-loading" />
          <Skeleton width="100%" height={88} radius={t.radius.card} />
        </>
      ) : (
        <>
          <RadarCard rating={rating} scores={data.coaching.scores} />
          <SummaryCard coaching={data.coaching.coaching} />
          <BestsCard bests={data.bests} onOpen={onOpenDrive} />
          <SegmentedControl accessibilityLabel={analyticsCopy.range} segments={SEGMENTS} value={range} onChange={onRange} testID="analytics-range" />
          <MetricsCards sums={data.sums} trend={data.trend} />
          <WhenYouDriveCard grid={data.grid} />
          <TripsMapCard routes={data.routes} region={data.region} />
          <DrivesCard drives={data.drives} rangeKey={range} onOpen={onOpenDrive} />
        </>
      )}
    </Screen>
  );
}
