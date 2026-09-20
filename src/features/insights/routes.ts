/**
 * Where the insight screens live, and how the period travels between them.
 *
 * The period is a query param rather than component state so that the selection survives a push
 * to a category and a swipe back, and so a deep link into a category can name the window it was
 * shared from. Every `push` below carries it; `parsePeriod` on the far side forgives anything
 * that is not one of the four.
 */
import type { EventCategory } from '@scoring';
import type { Href } from 'expo-router';

import type { InsightsPeriod } from './period';

/** E1 — the overview. */
export const insightsHref = (period: InsightsPeriod): Href => ({
  pathname: '/(app)/insights',
  params: { period },
});

/** E2 — one behaviour. */
export const categoryHref = (category: EventCategory, period: InsightsPeriod): Href => ({
  pathname: '/(app)/insights/[category]',
  params: { category, period },
});

/** E3 — totals and records. */
export const totalsHref = (period: InsightsPeriod): Href => ({
  pathname: '/(app)/insights/totals',
  params: { period },
});

/** E4 — how scoring works. No period: the model is the model whatever window is open. */
export const howScoringWorksHref = (): Href => '/(app)/insights/how-scoring-works';

/**
 * D1 — a drive's card back, where E2's example drives land. Spelled here rather than imported
 * from `@/features/trips` so the two features stay independent; the path is the route file's.
 */
export const tripSummaryHref = (clientTripId: string): Href => ({
  pathname: '/(app)/trips/[clientTripId]/summary',
  params: { clientTripId },
});
