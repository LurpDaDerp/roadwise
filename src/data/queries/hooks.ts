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
import { CONSTANTS, type ScoreBand } from '@scoring';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { TripRow } from '@/data/db/types';
import { useHydrationStatus, type HydrationStatus } from '@/data/hydrate/status';
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

// ---------------------------------------------------------------------------------------------
// The long-term score (R9)
// ---------------------------------------------------------------------------------------------

/**
 * What Home's licence card and E1's ring show for the long-term score.
 *
 * The number is **the server's**: `longTermScore` from the highest-`day` row of the day cache,
 * which finalize, every trip action and hydration all write. It is always shown with the day it
 * was computed (`asOfDay`), because it is a value as of that day, not a live one — offline for a
 * week, the card honestly says "as of" a week ago. The device's own `buildInsights().longTerm` is
 * computed from a different set of trips and is not to be rendered beside it.
 *
 * - `score` — the newest row carries a score.
 * - `building` — the newest row says there is not enough driving for one yet (the server decided
 *   that, not a local count), or there is no row and no scored drive at all.
 * - `waiting` — no row yet, but this device holds scored drives: the score appears when they sync.
 * - `restoring` — no row yet and a restore from the server is owed or running. Never "building"
 *   in that state: for an experienced driver on a new phone that would be false.
 */
export interface LongTermScoreView {
  state: 'restoring' | 'building' | 'score' | 'waiting';
  score: number | null;
  band: ScoreBand | null;
  /** The `YYYY-MM-DD` the score was computed for — the newest day row's own date. */
  asOfDay: string | null;
  /** The newest day row is still provisional (more trips for that day may yet arrive). */
  provisional: boolean;
  /** Local scored driver drives, for "Building your score: N of 3". */
  scoredDrives: number;
  /**
   * Drives that can still move the score and have not reached the server: driver role, scored on
   * this device (so neither too short, nor discarded, nor graded out), not deleted, and still on
   * their way (`local | queued | uploading`). A `failed` upload is not counted — it will not
   * arrive, so "waiting to sync" would promise a change that is not coming.
   */
  pendingDrives: number;
}

const SCORE_BANDS: readonly ScoreBand[] = ['excellent', 'good', 'getting_there', 'needs_focus'];

/** The newest day row, read leniently: this app wrote it from a strictly parsed server reply. */
export interface LatestDay {
  day: string;
  longTermScore: number | null;
  band: ScoreBand | null;
  provisional: boolean;
}

/** What the reader found; the restore state is folded in by the hook. */
export interface LongTermScoreInputs {
  latest: LatestDay | null;
  scoredDrives: number;
  pendingDrives: number;
}

function toLatestDay(day: string, payload: unknown): LatestDay {
  const raw =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const score = raw.longTermScore;
  const band = raw.band;
  return {
    day,
    longTermScore:
      typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100
        ? score
        : null,
    band:
      typeof band === 'string' && (SCORE_BANDS as readonly string[]).includes(band)
        ? (band as ScoreBand)
        : null,
    // A row that does not say is treated as provisional: that is the claim that promises less.
    provisional: raw.provisional !== false,
  };
}

const isDriverScored = (row: TripRow): boolean =>
  row.deleted_at === null && row.role === 'driver' && isScoredRow(row);

const PENDING_STATES: readonly TripRow['sync_state'][] = ['local', 'queued', 'uploading'];

export async function readLongTermScore(db: Db): Promise<LongTermScoreInputs> {
  const entry = await createScoreDailyCacheRepo(db).latest<unknown>();
  const rows = await createTripsRepo(db).list();
  const scored = rows.filter(isDriverScored);
  return {
    latest: entry === null ? null : toLatestDay(entry.day, entry.payload),
    scoredDrives: scored.length,
    pendingDrives: scored.filter((row) => PENDING_STATES.includes(row.sync_state)).length,
  };
}

/**
 * Whether a restore is owed and not yet finished. A failed full restore counts: it is retried at
 * the next foreground, and until it completes the device does not know the driver's history.
 */
export const isRestoring = (status: HydrationStatus): boolean =>
  status.state === 'restoring' || status.state === 'failed';

export function toLongTermScoreView(
  inputs: LongTermScoreInputs,
  restoring: boolean
): LongTermScoreView {
  const { latest, scoredDrives, pendingDrives } = inputs;
  const counts = { scoredDrives, pendingDrives };
  if (latest !== null) {
    const hasScore = latest.longTermScore !== null;
    return {
      state: hasScore ? 'score' : 'building',
      score: latest.longTermScore,
      band: hasScore ? latest.band : null,
      asOfDay: latest.day,
      provisional: latest.provisional,
      ...counts,
    };
  }
  const empty = { score: null, band: null, asOfDay: null, provisional: false, ...counts };
  if (restoring) return { state: 'restoring', ...empty };
  return { state: scoredDrives > 0 ? 'waiting' : 'building', ...empty };
}

/** The long-term score for Home and E1 (R9). Re-renders when a restore starts or ends. */
export function useLongTermScore(): UseQueryResult<LongTermScoreView> {
  const { db } = useDataSource();
  const restoring = isRestoring(useHydrationStatus());
  const select = useCallback(
    (inputs: LongTermScoreInputs) => toLongTermScoreView(inputs, restoring),
    [restoring]
  );
  return useQuery({
    queryKey: queryKeys.longTermScore(),
    queryFn: () => readLongTermScore(db),
    select,
  });
}
