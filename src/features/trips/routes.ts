/**
 * Where the drive screens live, in one place. Every `Href` below names a file that exists, so the
 * compiler checks each one against Expo Router's generated union.
 */
import type { Href } from 'expo-router';

export const HOME_HREF: Href = '/(tabs)/home';

/** Drive history. */
export const TRIP_HISTORY_HREF: Href = '/(app)/drives';

/** How points work. */
export const HOW_POINTS_WORK_HREF: Href = '/(app)/how-points-work';

/** A drive's summary. */
export const tripSummaryHref = (clientTripId: string): Href => ({
  pathname: '/(app)/drives/[clientTripId]',
  params: { clientTripId },
});
