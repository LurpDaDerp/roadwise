/**
 * Where the trip screens live, in one place. Task 7 builds D2 (the full trip) and D3 (the event
 * list) under the same `[clientTripId]` folder; the names below are the contract between the
 * two tasks, so the summary's footer links land on them the day they exist.
 */
import type { Href } from 'expo-router';

export const HOME_HREF: Href = '/(tabs)/home';

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

/**
 * D2 and D3 are not built yet, so their names are not in the generated route types. The cast is
 * confined to these two lines; when Task 7 adds the screens, the casts come off and the
 * compiler checks them like the rest.
 */
const pending = (path: string): Href => path as Href;

/** D2 — the full trip: map and timeline (Task 7). */
export const tripDetailHref = (clientTripId: string): Href =>
  pending(`/(app)/trips/${clientTripId}`);

/** D3 — the event list, where "Something wrong?" goes (Task 7). */
export const tripEventsHref = (clientTripId: string): Href =>
  pending(`/(app)/trips/${clientTripId}/events`);
