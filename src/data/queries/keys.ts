/**
 * Query keys and the filter/period vocabulary the screens select with.
 *
 * Every key is namespaced by its own root (`trips`, `trip`, `tripEvents`, `scoreDaily`,
 * `insights`) so `invalidateAfterSync` can sweep a whole family with one prefix and a screen can
 * still invalidate one trip. React Query hashes a key by a key-sorted `JSON.stringify`, which
 * drops `undefined` values — `normalizeTripsFilter` makes that explicit rather than relying on
 * it, so two callers who spell the same filter differently share one cache entry.
 */
import type { EventCategory, ScoreBand, TripMetrics } from '@scoring';

/** Who was at the wheel, as `trips.role` stores it (§9.7). */
export type TripRole = TripMetrics['role'];
export const TRIP_ROLES: readonly TripRole[] = ['driver', 'passenger', 'other', 'unknown'];

/** The E1 period selector: 4 weeks / 3 months / 12 months / all. */
export type InsightsPeriod = '4w' | '3mo' | '12mo' | 'all';
export const INSIGHTS_PERIODS: readonly InsightsPeriod[] = ['4w', '3mo', '12mo', 'all'];

/** Days the period covers. `all` has no lower bound; the window starts at the first trip. */
export const PERIOD_DAYS: Record<Exclude<InsightsPeriod, 'all'>, number> = {
  '4w': 28,
  '3mo': 91,
  '12mo': 365,
};

/** An inclusive span of local calendar dates, `YYYY-MM-DD` — what `score_daily_cache` is keyed by. */
export interface DayRange {
  from: string;
  to: string;
}

/**
 * The D4 history filters. `vehicle` is not here: M2 has no vehicles table.
 *
 * `category` selects trips where that category *cost points*, which is the honest local reading
 * of "trips with events in this category": a `possible` or disputed event is shown on the trip
 * but deducts nothing, and the driver filtering by "speeding" is looking for the trips speeding
 * actually cost them.
 */
export interface TripsFilter {
  role?: TripRole;
  band?: ScoreBand;
  category?: EventCategory;
  /** `started_at >= from`, epoch ms. */
  from?: number;
  /** `started_at <= to`, epoch ms. */
  to?: number;
  /** Only trips that carry a score (locally `provisional` or `final`). */
  scoredOnly?: boolean;
  /** Include trips the scorer discarded as not-a-drive (§9.4). Off by default. */
  includeDiscarded?: boolean;
  limit?: number;
  offset?: number;
}

/** The filter with `undefined` keys dropped and the rest in a fixed order, so keys hash alike. */
export function normalizeTripsFilter(filter: TripsFilter = {}): TripsFilter {
  const out: TripsFilter = {};
  if (filter.role !== undefined) out.role = filter.role;
  if (filter.band !== undefined) out.band = filter.band;
  if (filter.category !== undefined) out.category = filter.category;
  if (filter.from !== undefined) out.from = filter.from;
  if (filter.to !== undefined) out.to = filter.to;
  if (filter.scoredOnly !== undefined) out.scoredOnly = filter.scoredOnly;
  if (filter.includeDiscarded !== undefined) out.includeDiscarded = filter.includeDiscarded;
  if (filter.limit !== undefined) out.limit = filter.limit;
  if (filter.offset !== undefined) out.offset = filter.offset;
  return out;
}

export const queryKeys = {
  trips: (filter: TripsFilter = {}) => ['trips', normalizeTripsFilter(filter)] as const,
  trip: (clientTripId: string) => ['trip', clientTripId] as const,
  tripEvents: (clientTripId: string) => ['tripEvents', clientTripId] as const,
  scoreDaily: (range: DayRange) => ['scoreDaily', { from: range.from, to: range.to }] as const,
  insights: (period: InsightsPeriod) => ['insights', period] as const,
};

/**
 * Every root the data layer owns. `invalidateAfterSync` walks this list, so a new family added
 * above is refreshed after a sync the moment its root is named here.
 */
export const QUERY_ROOTS = ['trips', 'trip', 'tripEvents', 'scoreDaily', 'insights'] as const;
export type QueryRoot = (typeof QUERY_ROOTS)[number];
