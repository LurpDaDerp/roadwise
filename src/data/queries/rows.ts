/**
 * Row → view mappers: the one place a stored column is turned into the shape a screen reads.
 *
 * Every function here is pure and synchronous, so the trip list, the trip detail, the day strip
 * and the insight aggregations all agree on what "scored", "band" and "night" mean without any
 * of them touching SQLite. The `*_json` columns are parsed with a cast rather than a schema:
 * this app wrote them, they never came off the wire, and a row that predates a field reads as
 * the field's default instead of failing a screen (the same rule `settings.ts` states).
 */
import { band, CATEGORY, CONSTANTS } from '@scoring';
import type { EventCategory, ScorableEvent, ScoreBand, ScoredTrip } from '@scoring';

import type { EventRow, ScoreDailyCache, TripRow, TripStatus, TripSyncState } from '@/data/db/types';
import type { TripRole, TripsFilter } from '@/data/queries/keys';
import { dayKey } from '@/lib/time';

/** The six scoring categories, in the order `CATEGORY` declares them. */
export const CATEGORIES = Object.keys(CATEGORY) as EventCategory[];

const isCategory = (value: string): value is EventCategory =>
  (CATEGORIES as readonly string[]).includes(value);

function parseObject(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A truncated write from a killed process: the trip's other columns are still worth showing.
    return {};
  }
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const flag = (value: unknown): boolean => value === true;

/**
 * `category_deductions_json` with every category present and non-finite values floored to 0, so
 * a caller can sum across trips without guarding each lookup (`noUncheckedIndexedAccess` makes
 * that guard otherwise mandatory at every call site).
 */
export function parseCategoryDeductions(json: string | null): Record<EventCategory, number> {
  const raw = parseObject(json);
  const out = {} as Record<EventCategory, number>;
  for (const category of CATEGORIES) out[category] = Math.max(0, num(raw[category]));
  return out;
}

export interface TripConditions {
  night: boolean;
  precipitation: boolean;
  hadSevereEvent: boolean;
}

export function parseConditions(json: string | null): TripConditions {
  const raw = parseObject(json);
  return {
    night: flag(raw.night),
    precipitation: flag(raw.precipitation),
    hadSevereEvent: flag(raw.hadSevereEvent),
  };
}

/**
 * A trip carries a score while it is `provisional` (scored on device, not yet confirmed) and
 * once it is `final` (the server agreed). Both are "a scored trip" to every screen and to the
 * long-term score; only the day evaluation (§9.9) insists on `final`, and that runs on the
 * server.
 */
export function isScoredRow(row: TripRow): boolean {
  return row.score !== null && (row.status === 'provisional' || row.status === 'final');
}

/** One trip as D1/D4 read it. Timestamps stay epoch ms; distances stay metres. */
export interface TripSummary {
  clientTripId: string;
  startedAt: number;
  /** Null only while a trip is still recording, which no list ever shows. */
  endedAt: number | null;
  tz: string;
  /** The trip's own local calendar date, `YYYY-MM-DD` — what D4 groups by. */
  day: string;
  distanceM: number;
  durationS: number;
  role: TripRole;
  mode: string | null;
  status: TripStatus;
  score: number | null;
  band: ScoreBand | null;
  /** The trip has a score: `provisional` or `final` with a number. */
  scored: boolean;
  exposure: number | null;
  dataQuality: 'A' | 'B' | 'C' | null;
  categoryDeductions: Record<EventCategory, number>;
  /** The category that cost this trip the most, or null when nothing did. */
  worstCategory: EventCategory | null;
  /** Points lost across every category. */
  deduction: number;
  conditions: TripConditions;
  limitCoveragePct: number | null;
  startLabel: string | null;
  endLabel: string | null;
  polyline: string | null;
  cameraSession: boolean;
  /** Finalized by crash recovery from a checkpoint (§19.1): its tail may be missing. */
  incomplete: boolean;
  syncState: TripSyncState;
  syncError: string | null;
  /** The upload has not settled yet — D1 marks its points provisional. */
  pendingSync: boolean;
  serverId: string | null;
}

const ROLES: readonly string[] = ['driver', 'passenger', 'other', 'unknown'];
const QUALITIES: readonly string[] = ['A', 'B', 'C'];

function worstOf(deductions: Record<EventCategory, number>): EventCategory | null {
  let worst: EventCategory | null = null;
  let most = 0;
  // Largest cap first, so two categories that cost the same resolve to the costlier one — the
  // same tie-break `pickTopTip` walks.
  for (const category of [...CATEGORIES].sort(
    (a, b) => CATEGORY[b].cap - CATEGORY[a].cap || (a < b ? -1 : 1)
  )) {
    if (deductions[category] > most) {
      worst = category;
      most = deductions[category];
    }
  }
  return worst;
}

export function toTripSummary(row: TripRow): TripSummary {
  const categoryDeductions = parseCategoryDeductions(row.category_deductions_json);
  const scored = isScoredRow(row);
  return {
    clientTripId: row.client_trip_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    tz: row.tz,
    day: dayKey(new Date(row.started_at), row.tz),
    distanceM: row.distance_m,
    durationS: row.duration_s,
    role: row.role !== null && ROLES.includes(row.role) ? (row.role as TripRole) : 'unknown',
    mode: row.mode,
    status: row.status,
    score: row.score,
    band: scored && row.score !== null ? band(row.score) : null,
    scored,
    exposure: row.exposure,
    dataQuality:
      row.data_quality !== null && QUALITIES.includes(row.data_quality)
        ? (row.data_quality as 'A' | 'B' | 'C')
        : null,
    categoryDeductions,
    worstCategory: worstOf(categoryDeductions),
    deduction: CATEGORIES.reduce((sum, category) => sum + categoryDeductions[category], 0),
    conditions: parseConditions(row.conditions_json),
    limitCoveragePct: row.limit_coverage_pct,
    startLabel: row.start_label,
    endLabel: row.end_label,
    polyline: row.polyline,
    cameraSession: row.camera_session === 1,
    incomplete: row.incomplete === 1,
    syncState: row.sync_state,
    syncError: row.sync_error,
    pendingSync: row.sync_state !== 'synced' && row.sync_state !== 'failed',
    serverId: row.server_id,
  };
}

/**
 * Trips a list never shows, whatever the filter says:
 * - `recording` — the row the engine is writing to. Recovery finalizes it at app start (§19.1),
 *   so a list that showed it would be showing a trip that is about to change under the driver.
 * - `discarded` — the scorer decided this was not a drive (a train, a plane, §9.4). The local
 *   schema has no `deleted_at`, and this is the row the driver would call deleted; `finalizeTrip`
 *   settles it as `synced` and never uploads it. `includeDiscarded` brings it back.
 */
export function isHiddenTrip(summary: TripSummary, filter: TripsFilter = {}): boolean {
  if (summary.status === 'recording') return true;
  return summary.status === 'discarded' && filter.includeDiscarded !== true;
}

export function matchesTripsFilter(summary: TripSummary, filter: TripsFilter = {}): boolean {
  if (isHiddenTrip(summary, filter)) return false;
  if (filter.role !== undefined && summary.role !== filter.role) return false;
  if (filter.band !== undefined && summary.band !== filter.band) return false;
  if (filter.category !== undefined && summary.categoryDeductions[filter.category] <= 0) {
    return false;
  }
  if (filter.from !== undefined && summary.startedAt < filter.from) return false;
  if (filter.to !== undefined && summary.startedAt > filter.to) return false;
  if (filter.scoredOnly === true && !summary.scored) return false;
  return true;
}

/** Newest first, then by id — the order `trips.list` already returns, restated for TS filtering. */
export function sortTripsNewestFirst(trips: readonly TripSummary[]): TripSummary[] {
  return [...trips].sort(
    (a, b) => b.startedAt - a.startedAt || (a.clientTripId < b.clientTripId ? -1 : 1)
  );
}

/** `limit`/`offset` applied *after* filtering, so page 2 of a filtered list is the right page. */
export function pageOf(trips: readonly TripSummary[], filter: TripsFilter = {}): TripSummary[] {
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = filter.limit;
  return limit === undefined || limit < 0
    ? trips.slice(offset)
    : trips.slice(offset, offset + limit);
}

/** Why the scorer withheld a score (§9.4). The trip row stores the verdict, not the reason. */
export type UnscoredReason = NonNullable<ScoredTrip['reason']>;

/**
 * Re-derive the reason a trip carries no score, in the order `scoreTrip` decides it: a discarded
 * trip was implausibly fast, then a non-driver, then a trip too short, then data the phone could
 * not grade. Null for a scored trip, and null when nothing in the row explains it — better than
 * telling the driver a reason that is not theirs.
 */
export function unscoredReasonOf(summary: TripSummary): UnscoredReason | null {
  if (summary.scored) return null;
  if (summary.status === 'discarded') return 'implausible_speed';
  if (summary.role !== 'driver') return 'passenger';
  if (
    summary.distanceM < CONSTANTS.MIN_SCORED_DISTANCE_M ||
    summary.durationS < CONSTANTS.MIN_SCORED_DURATION_S
  ) {
    return 'too_short';
  }
  if (summary.dataQuality === 'C' || summary.dataQuality === null) return 'grade_c';
  return null;
}

/**
 * Which card the trip summary shows, because `pickTopTip` returns null for two unrelated reasons
 * and the screen has to tell them apart (§7.D D1):
 *
 * - `coach` — a category cost points; `pickTopTip` returns that category's tip.
 * - `keep_it_up` — the trip is scored and nothing cost points. `pickTopTip` returns null; pair it
 *   with `keepItUpTip`, whose copy asserts the trip really was clean.
 * - `facts_only` — the trip has no score (passenger, too short, grade C, discarded). There is
 *   nothing to coach: show the facts and `unscoredReason`, never a tip.
 */
export type TipOutcome = 'coach' | 'keep_it_up' | 'facts_only';

export function tipOutcomeOf(summary: TripSummary): TipOutcome {
  if (!summary.scored) return 'facts_only';
  return summary.worstCategory === null ? 'keep_it_up' : 'coach';
}

export type EventStatus = ScorableEvent['status'];
const EVENT_STATUSES: readonly string[] = ['scored', 'possible', 'disputed', 'removed'];

/** One event as the D2 timeline and D3 detail read it. */
export interface TripEventView {
  id: string;
  clientTripId: string;
  /** Null when the stored string is not one of the six scoring categories. */
  category: EventCategory | null;
  rawCategory: string;
  startedAt: number;
  durationS: number;
  lat: number | null;
  lng: number | null;
  /** `severity()` as the engine computed it (§9.3); null when the column was never written. */
  severity: number | null;
  confidence: number | null;
  deduction: number;
  measured: ScorableEvent['measured'];
  context: ScorableEvent['context'];
  status: EventStatus | null;
  /** Shown as "possible" and explicitly labelled as not affecting the score (§7.D D1). */
  possible: boolean;
  /** This event actually cost points. */
  affectsScore: boolean;
  alertShown: boolean;
  corrected: boolean;
  source: string | null;
}

export function toTripEventView(row: EventRow): TripEventView {
  const severity = row.severity === null ? null : Number(row.severity);
  const deduction = Math.max(0, num(row.deduction));
  const context = parseObject(row.context_json);
  const status =
    row.status !== null && EVENT_STATUSES.includes(row.status) ? (row.status as EventStatus) : null;
  return {
    id: row.id,
    clientTripId: row.client_trip_id,
    category: isCategory(row.category) ? row.category : null,
    rawCategory: row.category,
    startedAt: row.started_at,
    durationS: row.duration_s,
    lat: row.lat,
    lng: row.lng,
    severity: severity !== null && Number.isFinite(severity) ? severity : null,
    confidence: row.confidence,
    deduction,
    measured: parseObject(row.measured_json) as ScorableEvent['measured'],
    context: { night: flag(context.night), precipitation: flag(context.precipitation) },
    status,
    possible: status === 'possible',
    affectsScore: status === 'scored' && deduction > 0,
    alertShown: row.alert_shown === 1,
    corrected: row.corrected === 1,
    source: row.source,
  };
}

/** One cached day (§9.9) as the home strip and the history day headers read it. */
export interface DayEntry {
  day: string;
  updatedAt: number | null;
  safeDay: boolean;
  goodDay: boolean;
  phoneFreeDay: boolean;
  cameraDay: boolean;
  /** Recomputed from the flags with `CONSTANTS.POINTS`; the stored row does not carry it. */
  points: number;
  drivingS: number | null;
  tripsScored: number | null;
  severeEvents: number | null;
  exposure: number | null;
  longTermScore: number | null;
  band: ScoreBand | null;
  /** The long-term score was still being built when this day was written. */
  provisional: boolean | null;
  /** True when the cached payload was not a day object this build understands. */
  unreadable: boolean;
}

const POINTS = CONSTANTS.POINTS;
const BANDS: readonly string[] = ['excellent', 'good', 'getting_there', 'needs_focus'];

const optionalNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const optionalBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

/**
 * Read a cached day payload leniently.
 *
 * The runner caches whatever `finalize-trip` returned under `day`, verbatim (Task 3, deviation 3):
 * today that is the day's own row, but a build whose server answers with an array of day rows, or
 * with the bare day string, must degrade to "no badges" rather than blank the screen. Anything
 * this build cannot read comes back with the flags off and `unreadable` set.
 */
export function toDayEntry(entry: ScoreDailyCache<unknown>): DayEntry {
  const payload = entry.payload;
  const rows = Array.isArray(payload) ? payload : [payload];
  const match = rows.find(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row)
  );
  const raw = match ?? {};
  const rawBand = raw.band;
  const safeDay = flag(raw.safeDay);
  const goodDay = flag(raw.goodDay);
  const phoneFreeDay = flag(raw.phoneFreeDay);
  const cameraDay = flag(raw.cameraDay);
  return {
    day: entry.day,
    updatedAt: entry.updated_at,
    safeDay,
    goodDay,
    phoneFreeDay,
    cameraDay,
    points:
      (safeDay ? POINTS.safeDay : goodDay ? POINTS.goodDay : 0) +
      (phoneFreeDay ? POINTS.phoneFreeDay : 0) +
      (cameraDay ? POINTS.cameraDay : 0),
    drivingS: optionalNumber(raw.drivingS),
    tripsScored: optionalNumber(raw.tripsScored),
    severeEvents: optionalNumber(raw.severeEvents),
    exposure: optionalNumber(raw.exposure),
    longTermScore: optionalNumber(raw.longTermScore),
    band: typeof rawBand === 'string' && BANDS.includes(rawBand) ? (rawBand as ScoreBand) : null,
    provisional: optionalBoolean(raw.provisional),
    unreadable: match === undefined,
  };
}
