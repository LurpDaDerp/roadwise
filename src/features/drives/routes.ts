/**
 * Where the drive screens live. Every `Href` names a route file, so the compiler checks each one
 * against Expo Router's generated union.
 */
import type { Href } from 'expo-router';

export const HOME_HREF: Href = '/(tabs)/home';
export const ANALYTICS_HREF: Href = '/(tabs)/analytics';
export const PROFILE_HREF: Href = '/(tabs)/profile';
export const DRIVE_HREF: Href = '/drive';
export const DRIVE_HISTORY_HREF: Href = '/(app)/drives';
export const HOW_SCORES_WORK_HREF: Href = '/(app)/how-scores-work';
export const PERMISSIONS_HREF: Href = '/(app)/settings/permissions';

/** A drive's summary; `fresh` right after the drive ends plays the reveal. */
export const driveSummaryHref = (clientTripId: string, fresh = false): Href => ({
  pathname: '/(app)/drives/[clientTripId]',
  params: fresh ? { clientTripId, fresh: '1' } : { clientTripId },
});
