import { useState } from 'react';

import type { SpotsView } from '@/data/queries/spots';
import { Banner, Screen, Skeleton, useTheme } from '@/ui';

import { AllTimeCard } from './AllTimeCard';
import { CategorySheet } from './CategorySheet';
import { analyticsCopy } from './copy';
import { DrivesCard } from './DrivesCard';
import { MetricsCards } from './MetricsCards';
import type { AxisKey, Range } from './model';
import { RadarCard } from './RadarCard';
import { SpotSheet, SpotsCard } from './spots';
import { SummaryCard } from './SummaryCard';
import { TimeOfDayCard } from './TimeOfDayCard';
import { TripsMapCard } from './TripsMapCard';
import type { AnalyticsData } from './useAnalytics';
import { WhenYouDriveCard } from './WhenYouDriveCard';

export interface AnalyticsViewProps {
  data: AnalyticsData;
  /** The 90-day Safety Rating (`data.coaching.rating`, 1 decimal); null while unranked or before it exists. */
  rating: number | null;
  /** The problem spots (`useSpots`); null while they load. */
  spots?: SpotsView | null;
  range: Range;
  onRange: (range: Range) => void;
  onOpenDrive: (clientTripId: string) => void;
  /** A DashPal is paired: without one the radar's Attention is locked. */
  dashpalPaired: boolean;
  /** Opens Settings › DashPal (Attention's sheet, without one). */
  onPairDashpal: () => void;
}

/**
 * The Analytics tab, top to bottom: the 90-day radar with the Safety Rating, the coaching line,
 * the all-time totals (the longest clean drive and the clean drives), then the range group (an
 * outline holding the range toggle and the only two cards it moves: Driving and Trends), then,
 * all time, when you drive and a comment on it, the all-trips map with the problem spots on it,
 * the spots to watch and the drives list. Every card is paper. Each radar category opens a sheet
 * with that behaviour's own numbers over the range, and each spot its own sheet; the page keeps
 * only general ones.
 */
export function AnalyticsView({ data, rating, spots = null, range, onRange, onOpenDrive, dashpalPaired, onPairDashpal }: AnalyticsViewProps) {
  const t = useTheme();
  // The axis stays set while the sheet slides away, so its content doesn't blank on the way out.
  const [sheet, setSheet] = useState<{ axis: AxisKey; open: boolean }>({ axis: 'speed', open: false });
  const close = () => setSheet((s) => ({ ...s, open: false }));
  const [spotSheet, setSpotSheet] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const openSpot = (id: string) => setSpotSheet({ id, open: true });
  const closeSpot = () => setSpotSheet((s) => ({ ...s, open: false }));
  // A spot that leaves the list (cleared, or inside a new privacy zone) closes its sheet.
  const spot = spots?.active.find((s) => s.id === spotSheet.id) ?? null;
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
          <RadarCard rating={rating} scores={data.coaching.scores} dashpalPaired={dashpalPaired} onOpen={(axis) => setSheet({ axis, open: true })} />
          <SummaryCard coaching={data.coaching.coaching} />
          <AllTimeCard allTime={data.allTime} onOpen={onOpenDrive} />
          <MetricsCards sums={data.sums} trend={data.trend} range={range} onRange={onRange} />
          <WhenYouDriveCard grid={data.grid} />
          <TimeOfDayCard grid={data.grid} nightPct={data.allTime.nightPct} />
          <TripsMapCard routes={data.routes} region={data.region} spots={spots?.active ?? []} onSpot={openSpot} />
          <SpotsCard view={spots} onOpen={openSpot} />
          <DrivesCard drives={data.drives} onOpen={onOpenDrive} />
          <CategorySheet
            axis={sheet.axis}
            visible={sheet.open}
            onClose={close}
            score={data.coaching.scores[sheet.axis]}
            last90={data.coaching.totals}
            sums={data.sums}
            range={range}
            onRange={onRange}
            dashpalPaired={dashpalPaired}
            onPairDashpal={() => {
              close();
              onPairDashpal();
            }}
          />
          <SpotSheet
            spot={spot}
            visible={spotSheet.open && spot !== null}
            onClose={closeSpot}
            onOpenDrive={(id: string) => {
              closeSpot();
              onOpenDrive(id);
            }}
          />
        </>
      )}
    </Screen>
  );
}
