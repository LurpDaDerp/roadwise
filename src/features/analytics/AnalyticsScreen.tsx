import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useDashpalChip } from '@/dashcam/ui/HudDashpal';
import { useSpots } from '@/data/queries/spots';
import { passengerRidesShown, usePassengerRides } from '@/data/server/passengerRides';
import { driveSummaryHref } from '@/features/drives/routes';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { AnalyticsView } from './AnalyticsView';
import type { Range } from './model';
import { useAnalytics } from './useAnalytics';

/**
 * The Analytics tab: local drives through `useAnalytics` (the radar's centre is their 90-day
 * Safety Rating), the problem spots this phone found (`useSpots`) and the month's passenger rides
 * (the server's count, `usePassengerRides`).
 */
export function AnalyticsScreen() {
  const router = useRouter();
  const [range, setRange] = useState<Range>('week');
  const data = useAnalytics(range);
  const spots = useSpots();
  const passengerRides = passengerRidesShown(usePassengerRides(null));
  const { rating } = data.coaching;
  const dashpalPaired = useDashpalChip() !== null;
  return (
    <AnalyticsView
      data={data}
      // Unranked (under 10 mi in 90 days) reads "—" here as it does on Home and Profile.
      rating={rating.ranked ? rating.rating : null}
      spots={spots.data ?? null}
      range={range}
      onRange={setRange}
      onOpenDrive={(id) => router.push(driveSummaryHref(id))}
      dashpalPaired={dashpalPaired}
      passengerRides={passengerRides}
      onPairDashpal={() => router.push(SETTINGS_HREFS.dashcam)}
    />
  );
}
