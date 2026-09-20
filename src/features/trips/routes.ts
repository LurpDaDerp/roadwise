/**
 * Where the trip screens live, in one place. Every `Href` below names a file that exists, so the
 * compiler checks each one against Expo Router's generated union — Task 6's `pending()` cast is
 * gone now that D2–D5 are built.
 */
import type { Href } from 'expo-router';

export const HOME_HREF: Href = '/(tabs)/home';

/** D4 — the history list. */
export const TRIP_HISTORY_HREF: Href = '/(app)/trips';

/** E4 — "How scoring works", where a data-quality grade is explained (Task 8's screen). */
export const HOW_SCORING_WORKS_HREF: Href = '/(app)/insights/how-scoring-works';

/** D1 — the card back. */
export const tripSummaryHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/summary',
  params: { clientTripId },
});

/** D6 — the coaching tip. */
export const tripTipHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/tip',
  params: { clientTripId },
});

/** D2 — the whole drive: map and timeline. */
export const tripDetailHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]',
  params: { clientTripId },
});

/** D3 list — "Something wrong?": every moment on the drive, to pick one from. */
export const tripEventsHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/events',
  params: { clientTripId },
});

/** D3 — one moment, and the report form. */
export const tripEventHref = (clientTripId: string, eventId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/events/[eventId]',
  params: { clientTripId, eventId },
});

/** D5 — edit the drive: who was driving, and delete. */
export const tripEditHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/edit',
  params: { clientTripId },
});
