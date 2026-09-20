// Re-scoring a stored trip (trip-actions): the scorer's inputs rebuilt from the row and its
// events, and the user's aggregates rebuilt around the trip's new outcome.
//
// finalize-trip scored the upload from the payload; a dispute or a role change scores the same
// trip again from what was stored. The trip-level inputs are `rows_digest` (kept verbatim for this
// purpose) and the quality cap finalize-trip applied, which is not persisted and is re-derived
// here from the same stored columns (`trace_path`, `incomplete`, `duration_s` against the wall
// span, `distance_m / duration_s` against the sustained maximum). Per event only the measurements
// and the context are read; severity and the context multiplier are recomputed by the scoring
// package, never taken from the stored (client-asserted) columns. The trace object is not read:
// no rule here needs it.
import { baselines, dayRows, localDay } from './aggregate.ts';
import type { Baselines, DayRow, DayTripInput, ScoredTripInput } from './aggregate.ts';
import type { RecomputeEventRow, StoredEvent, StoredTrip } from './actions_db.ts';
import type { Db } from './db.ts';
import { RowsDigestSchema } from './payload.ts';
import {
  SPAN_SLACK_S,
  SPEED_DIVERGENCE_FACTOR,
  SPEED_DIVERGENCE_SLACK_MPS,
  tripMetrics,
  type QualityDowngrade,
} from './plausibility.ts';
import { CONSTANTS, longTermScore } from './scoring/index';
import type { EventCategory, ScorableEvent, ScoredTrip, TripMetrics } from './scoring/index';

const DAY_MS = 86_400_000;

/** The quality downgrades finalize-trip applied to this trip, from the columns it stored. */
export function storedDowngrades(t: StoredTrip): QualityDowngrade[] {
  const out: QualityDowngrade[] = [];
  if (t.tracePath === null) out.push('no_trace');
  if (t.incomplete) out.push('incomplete');
  const spanS = (t.endedAt - t.startedAt) / 1000;
  if (t.durationS > spanS + SPAN_SLACK_S) out.push('duration_exceeds_span');
  const digest = RowsDigestSchema.safeParse(t.rowsDigest);
  if (digest.success && t.durationS > 0) {
    const max = digest.data.maxSustainedSpeedMps;
    const allowed = Math.max(max * SPEED_DIVERGENCE_FACTOR, max + SPEED_DIVERGENCE_SLACK_MPS);
    if (t.distanceM / t.durationS > allowed) out.push('distance_exceeds_speed');
  }
  return out;
}

/**
 * The scorer's trip-level inputs from the stored row, under `role`; null when the stored digest
 * is not one the contract recognises (an integrity failure, not a scorable trip).
 */
export function storedMetrics(t: StoredTrip, role: TripMetrics['role']): TripMetrics | null {
  const digest = RowsDigestSchema.safeParse(t.rowsDigest);
  if (!digest.success) return null;
  // tripMetrics takes the upload contract's role (driver | passenger); the stored role is wider.
  const base = tripMetrics(
    { distanceM: t.distanceM, durationS: t.durationS, role: 'driver', rowsDigest: digest.data },
    storedDowngrades(t)
  );
  return { ...base, role };
}

/** A stored event as the scorer takes it: the device's id, the measurements, the context. */
export function toScorableEvent(e: StoredEvent): ScorableEvent {
  return {
    id: e.clientEventId,
    category: e.category as EventCategory,
    startedAt: e.startedAt,
    durationS: e.durationMs / 1000,
    q: e.q,
    corrected: e.corrected,
    status: e.status as ScorableEvent['status'],
    measured: e.measured as ScorableEvent['measured'],
    context: { night: e.context.night === true, precipitation: e.context.precipitation === true },
  };
}

/** The `p_events` rows: every event of the trip with its status and the scorer's deduction. */
export function eventRows(events: readonly StoredEvent[], scored: ScoredTrip): RecomputeEventRow[] {
  return events.map((e) => ({
    id: e.id,
    status: e.status,
    deduction: scored.score === null ? null : (scored.eventDeductions[e.clientEventId] ?? 0),
  }));
}

/** What the trip is after the action, as the aggregates need it; null when it was deleted. */
export interface TripOutcome {
  score: number | null;
  status: DayTripInput['status'];
  exposure: number;
  categoryDeductions: Record<string, number>;
  /** Scored phone events after the action. */
  phoneEvents: number;
}

/** `upsert_score_day` casts these to int; the arithmetic upstream may leave fractions. */
const roundDay = (row: DayRow): DayRow => ({
  ...row,
  longTermScore: row.longTermScore === null ? null : Math.round(row.longTermScore),
  drivingS: Math.round(row.drivingS),
  tripsScored: Math.round(row.tripsScored),
  severeEvents: Math.round(row.severeEvents),
});

/**
 * The day rows and baselines as they stand once `trip` has `outcome`: the stored trips minus this
 * one, plus this one as it will be. The trip's own day always; today as well when the action
 * lands on a later day, so the long-term score moves today too (as finalize-trip does).
 */
export async function aggregatesAfter(
  db: Db,
  userId: string,
  nowMs: number,
  trip: StoredTrip,
  outcome: TripOutcome | null
): Promise<{ day: DayRow[]; baselines: Baselines | null }> {
  const today = localDay(nowMs, trip.tz);
  const days = today === trip.localDay ? [trip.localDay] : [trip.localDay, today];

  const stored = (await db.listScoredTrips(userId, nowMs - CONSTANTS.LONG_TERM_MAX_D * DAY_MS)).filter(
    (t) => t.id !== trip.id
  );
  const own: ScoredTripInput[] =
    outcome && outcome.status === 'final' && outcome.score !== null
      ? [
          {
            endedAt: trip.endedAt,
            score: outcome.score,
            exposure: outcome.exposure,
            durationS: trip.durationS,
            categoryDeductions: outcome.categoryDeductions,
          },
        ]
      : [];
  const allScored = [...own, ...stored];
  const lt = longTermScore(allScored, nowMs);

  const dayTrips = (await db.listDayTrips(userId, days)).filter((t) => t.id !== trip.id);
  const ownDay: DayTripInput[] = outcome
    ? [
        {
          localDay: trip.localDay,
          score: outcome.score,
          status: outcome.status,
          durationS: trip.durationS,
          exposure: outcome.exposure,
          hadSevereEvent: trip.hadSevereEvent,
          phoneEvents: outcome.phoneEvents,
          cameraGood: trip.cameraSession,
        },
      ]
    : [];

  return {
    day: dayRows(days, [...ownDay, ...dayTrips], lt).map(roundDay),
    baselines: baselines(allScored, nowMs),
  };
}
