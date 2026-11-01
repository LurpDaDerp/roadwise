import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

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
 * (the server's count, `usePassengerRides`). Each time the tab gains focus again (a switch back to
 * it included) `focusCount` goes up, which takes the All trips map back to the view framing every
 * route. The first focus leaves it be: the map opens on that view.
 */
export function AnalyticsScreen() {
  const router = useRouter();
  const [range, setRange] = useState<Range>('week');
  const [focusCount, setFocusCount] = useState(0);
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) setFocusCount((n) => n + 1);
      focusedOnce.current = true;
    }, [])
  );
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
      focusCount={focusCount}
      onPairDashpal={() => router.push(SETTINGS_HREFS.dashcam)}
    />
  );
}
