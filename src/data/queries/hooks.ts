/**
 * The query hooks the trip, history and insight screens read (§7.D, §7.E).
 *
 * Each hook is a thin wrapper: a namespaced key, and a reader that turns rows into the view
 * shapes in `rows.ts` and the aggregations in `insights.ts`. All the arithmetic lives in those
 * two pure modules, so the numbers a screen shows can be tested without rendering anything.
 *
 * The readers are exported beside the hooks because they are the useful unit under a sql.js
 * database: a test can call `readTrips(db, filter)` directly, and the hook adds only React Query.
 */
import { CONSTANTS } from '@scoring';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import { useDataSource } from '@/data/queries/context';
import {
  buildInsights,
  parseStoredBaseline,
  type Insights,
} from '@/data/queries/insights';
import {
  queryKeys,
  type DayRange,
  type InsightsPeriod,
  type TripsFilter,
} from '@/data/queries/keys';
import {
  isHiddenTrip,
  isScoredRow,
  matchesTripsFilter,
  pageOf,
  sortTripsNewestFirst,
  tipOutcomeOf,
  toDayEntry,
  toTripEventView,
  toTripSummary,
  unscoredReasonOf,
  type DayEntry,
  type TipOutcome,
  type TripEventView,
  type TripSummary,
  type UnscoredReason,
} from '@/data/queries/rows';

/**
 * Where the 8-week baseline medians (§9.6) are kept on device. The server computes them beside
 * every finalized trip; nothing writes this key yet, and until something does `useInsights`
 * falls back to the medians of the driver's own previous eight weeks.
 */
export const BASELINE_SETTING_KEY = 'insights.baseline';

/**
 * Where the driver is in their first miles — the `stage` argument `pickTopTip` takes. Structurally
 * `TipStage` from `@/content/tips`; restated here so the data layer does not depend on content.
 */
export type TripStage = 'new' | 'experienced';

/**
 * Read the history list.
 *
 * `trips.list()` is read whole and filtered in TypeScript rather than in SQL: the M1 repo filters
 * only by status, and a device holds hundreds of trips, not millions. Doing it here also means
 * `limit`/`offset` are applied *after* the filter, so page two of a filtered list is the second
 * page of the filtered list and not of the table.
 */
export async function readTrips(db: Db, filter: TripsFilter = {}): Promise<TripSummary[]> {
  const rows = await createTripsRepo(db).list();
  const visible = rows.map(toTripSummary).filter((trip) => matchesTripsFilter(trip, filter));
  return pageOf(sortTripsNewestFirst(visible), filter);
}

/** One trip, plus what the summary screen needs to choose between the three D1 variants. */
export interface TripDetail {
  trip: TripSummary;
  /** Scored trips the driver has made, this one included. */
  scoredTripCount: number;
  /**
   * `new` below `LEARNING_PERIOD_TRIPS` scored trips, `experienced` at or past it — the driver's
   * stage **now**, not at the time of this trip. Re-opening drive #1 after ten drives shows the
   * experienced copy, which is the right call: the tip is advice to act on today.
   */
  stage: TripStage;
  /** Which card D1 shows: a coaching tip, `keepItUpTip`, or the facts alone. */
  tipOutcome: TipOutcome;
  /** Why there is no score, when the row explains it. Null for a scored trip. */
  unscoredReason: UnscoredReason | null;
}

/**
 * The tip a screen shows is built from this result and `useTripEvents`:
 * `pickTopTip(toScoredTrip(trip, events), toScorableEvents(events), stage)`. Both bridges are in
 * `rows.ts` — see `toScoredTrip` for the rule that a locally `provisional` trip is the scorer's
 * `'final'`, without which every unsynced trip would lose its coaching.
 */

export async function readTrip(db: Db, clientTripId: string): Promise<TripDetail | null> {
  const trips = createTripsRepo(db);
  const row = await trips.get(clientTripId);
  // A deleted trip reads as no trip at all (§7.D D5): the row is only still here because the
  // server has not been told yet, and a screen that opened it would be showing a drive the
  // driver has already thrown away.
  if (row === null || row.deleted_at !== null) return null;

  // The learning-period stage is a count over the whole table, so it is read here rather than
  // left to the screen: the summary needs it before it can ask for a tip. A deleted drive is not
  // on the record and must not keep pushing the driver towards `LEARNING_PERIOD_TRIPS` — every
  // other read excludes it through `isHiddenTrip`; this one counts rows directly.
  const scoredTripCount = (await trips.list()).filter(
    (row) => row.deleted_at === null && isScoredRow(row)
  ).length;
  const trip = toTripSummary(row);
  return {
    trip,
    scoredTripCount,
    stage: scoredTripCount >= CONSTANTS.LEARNING_PERIOD_TRIPS ? 'experienced' : 'new',
    tipOutcome: tipOutcomeOf(trip),
    unscoredReason: unscoredReasonOf(trip),
  };
}

/** The D2 timeline, oldest first — the order the repo returns and the order the trip happened. */
export async function readTripEvents(db: Db, clientTripId: string): Promise<TripEventView[]> {
  const rows = await createEventsRepo(db).listByTrip(clientTripId);
  return rows.map(toTripEventView);
}

/** The cached day evaluations (§9.9) over an inclusive `YYYY-MM-DD` span, oldest first. */
export async function readScoreDaily(db: Db, range: DayRange): Promise<DayEntry[]> {
  const entries = await createScoreDailyCacheRepo(db).range<unknown>(range.from, range.to);
  return entries.map(toDayEntry);
}

export async function readInsights(
  db: Db,
  period: InsightsPeriod,
  now: number
): Promise<Insights> {
  const rows = await createTripsRepo(db).list();
  const stored = await createSettingsRepo(db).get<unknown>(BASELINE_SETTING_KEY);
  return buildInsights({
    // The same rows the history shows: a recording row is still moving and a discarded one was
    // not a drive, so neither belongs in a rate.
    trips: rows.map(toTripSummary).filter((trip) => !isHiddenTrip(trip)),
    period,
    now,
    baseline: parseStoredBaseline(stored),
  });
}

/** The D4 history list. Soft-deleted and recording rows never appear; `incomplete` is surfaced. */
export function useTrips(filter: TripsFilter = {}): UseQueryResult<TripSummary[]> {
  const { db } = useDataSource();
  return useQuery({
    queryKey: queryKeys.trips(filter),
    queryFn: () => readTrips(db, filter),
  });
}

/** The D1 summary. Null for a deleted trip. Disabled while the caller has no id to ask about. */
export function useTrip(
  clientTripId: string | null | undefined
): UseQueryResult<TripDetail | null> {
  const { db } = useDataSource();
  const id = clientTripId ?? '';
  return useQuery({
    queryKey: queryKeys.trip(id),
    queryFn: () => readTrip(db, id),
    enabled: id.length > 0,
  });
}

/** The D2/D3 event timeline for one trip. */
export function useTripEvents(
  clientTripId: string | null | undefined
): UseQueryResult<TripEventView[]> {
  const { db } = useDataSource();
  const id = clientTripId ?? '';
  return useQuery({
    queryKey: queryKeys.tripEvents(id),
    queryFn: () => readTripEvents(db, id),
    enabled: id.length > 0,
  });
}

/**
 * The home strip and the D4 day headers, from the cache the sync runner fills. Disabled — never
 * fetching, and no cache entry minted — while the caller has no span to ask about, which is the
 * state a screen is in until it knows which day its trip belongs to.
 */
export function useScoreDaily(range: DayRange | null): UseQueryResult<DayEntry[]> {
  const { db } = useDataSource();
  const span = range ?? { from: '', to: '' };
  return useQuery({
    queryKey: queryKeys.scoreDaily(span),
    queryFn: () => readScoreDaily(db, span),
    enabled: range !== null,
  });
}

/** Everything E1 draws for the selected period. */
export function useInsights(period: InsightsPeriod = '4w'): UseQueryResult<Insights> {
  const { db, now } = useDataSource();
  return useQuery({
    queryKey: queryKeys.insights(period),
    queryFn: () => readInsights(db, period, now()),
  });
}
