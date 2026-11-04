import { useRef, useState } from 'react';

import type { SpotsView } from '@/data/queries/spots';
import { Banner, Screen, Skeleton, useTheme } from '@/ui';

import { AllTimeCard } from './AllTimeCard';
import { CategorySheet } from './CategorySheet';
import { CommuteCard } from './CommuteCard';
import type { CommuteRow } from './commuteModel';
import { CommuteSheet } from './CommuteSheet';
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

/** The cards' place while the tab loads: the radar's and the coaching line's. */
function LoadingCards() {
  const t = useTheme();
  return (
    <>
      <Skeleton width="100%" height={340} radius={t.radius.card} testID="analytics-loading" />
      <Skeleton width="100%" height={88} radius={t.radius.card} />
    </>
  );
}

/** The tab as it loads, with no data read yet: its title over the loading cards. */
export function AnalyticsLoading() {
  return (
    <Screen sky scroll bottomInset={false} title={analyticsCopy.title} testID="analytics-screen">
      <LoadingCards />
    </Screen>
  );
}

export interface AnalyticsViewProps {
  data: AnalyticsData;
  /** The 90-day Safety Rating (`data.coaching.rating`, 1 decimal); null while unranked or before it exists. */
  rating: number | null;
  /** The problem spots (`useSpots`); null while they load. */
  spots?: SpotsView | null;
  /** The commute legs with enough drives (`useCommute`); none hides the card. */
  commute?: readonly CommuteRow[];
  range: Range;
  onRange: (range: Range) => void;
  onOpenDrive: (clientTripId: string) => void;
  /** A DashPal is paired: without one the radar's Attention is locked. */
  dashpalPaired: boolean;
  /** Opens Settings › DashPal (Attention's sheet, without one). */
  onPairDashpal: () => void;
  /** This month's passenger rides, shown under the drives when there are any; null for none or unknown. */
  passengerRides?: number | null;
  /** Goes up each time the tab gains focus again: the All trips map goes back to the view framing every route. */
  focusCount?: number;
}

/**
 * The Analytics tab, top to bottom: the 90-day radar with the Safety Rating, the coaching line,
 * the all-time totals (the longest clean drive and the clean drives), then the range group (an
 * outline holding the range toggle and the only two cards it moves: Driving and Trends), then,
 * all time, when you drive and a comment on it, the all-trips map with the problem spots on it,
 * the spots to watch, your commute and the drives list. Every card is paper. Each radar category
 * opens a sheet with that behaviour's own numbers over the range, each spot its own sheet, and each
 * commute leg one with its spots on the way (which open the spot's sheet once the leg's has gone)
 * and its newest drives; the page keeps only general ones.
 */
const NO_COMMUTE: readonly CommuteRow[] = [];

export function AnalyticsView({ data, rating, spots = null, commute = NO_COMMUTE, range, onRange, onOpenDrive, dashpalPaired, onPairDashpal, passengerRides = null, focusCount = 0 }: AnalyticsViewProps) {
  // The axis stays set while the sheet slides away, so its content doesn't blank on the way out.
  const [sheet, setSheet] = useState<{ axis: AxisKey; open: boolean }>({ axis: 'speed', open: false });
  const close = () => setSheet((s) => ({ ...s, open: false }));
  const [spotSheet, setSpotSheet] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const openSpot = (id: string) => setSpotSheet({ id, open: true });
  const closeSpot = () => setSpotSheet((s) => ({ ...s, open: false }));
  // A spot that leaves the list (cleared, or gone in a recompute) closes its sheet.
  const spot = spots?.active.find((s) => s.id === spotSheet.id) ?? null;
  const [legSheet, setLegSheet] = useState<{ id: CommuteRow['id'] | null; open: boolean }>({ id: null, open: false });
  const closeLeg = () => setLegSheet((s) => ({ ...s, open: false }));
  // A leg that leaves the card (too few drives now, a place removed) closes its sheet.
  const leg = commute.find((l) => l.id === legSheet.id) ?? null;
  // A spot tapped in a leg's sheet opens once that sheet has gone (iOS shows one modal at a time).
  const spotNext = useRef<string | null>(null);
  const first = data.loading && data.drives.length === 0;
  return (
    <Screen sky scroll bottomInset={false} title={analyticsCopy.title} testID="analytics-screen">
      {data.error ? <Banner tone="warning" message={analyticsCopy.error} /> : null}
      {first ? (
        <LoadingCards />
      ) : (
        <>
          <RadarCard rating={rating} scores={data.coaching.scores} dashpalPaired={dashpalPaired} onOpen={(axis) => setSheet({ axis, open: true })} />
          <SummaryCard coaching={data.coaching.coaching} />
          <AllTimeCard allTime={data.allTime} onOpen={onOpenDrive} />
          <MetricsCards sums={data.sums} trend={data.trend} range={range} onRange={onRange} />
          <WhenYouDriveCard grid={data.grid} />
          <TimeOfDayCard grid={data.grid} nightPct={data.allTime.nightPct} />
          <TripsMapCard routes={data.routes} region={data.region} spots={spots?.active ?? []} onSpot={openSpot} focusCount={focusCount} />
          <SpotsCard view={spots} onOpen={openSpot} />
          <CommuteCard rows={commute} onOpen={(id) => setLegSheet({ id, open: true })} />
          <DrivesCard drives={data.drives} onOpen={onOpenDrive} archived={data.archivedDrives} passengerRides={passengerRides} />
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
          <CommuteSheet
            row={leg}
            visible={legSheet.open && leg !== null}
            onClose={closeLeg}
            onDismiss={() => {
              // Gone from the screen (closed, or its leg left the card), the leg is let go: a closed sheet does no
              // work, and a leg that comes back to the card doesn't pop it open. A sheet shown again never sends this.
              setLegSheet({ id: null, open: false });
              const id = spotNext.current;
              spotNext.current = null;
              if (id !== null) openSpot(id);
            }}
            spots={spots?.active}
            onOpenSpot={(id: string) => {
              spotNext.current = id;
              closeLeg();
            }}
            onOpenDrive={(id: string) => {
              closeLeg();
              onOpenDrive(id);
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
