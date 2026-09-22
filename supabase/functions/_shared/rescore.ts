// Re-scoring a stored trip (trip-actions): the scorer's inputs rebuilt from the row and its
// events, and the user's aggregates rebuilt around the trip's new outcome.
//
// finalize-trip scored the upload from the payload; a dispute or a role change scores the same
// trip again from what was stored. The trip-level inputs are `rows_digest` (kept verbatim for this
// purpose) and the quality cap finalize-trip applied, which is re-derived here from the stored
// columns (`scored_without_trace`, `incomplete`, `duration_s` against the wall span,
// `distance_m / duration_s` against the sustained maximum). `no_trace` reads
// `scored_without_trace`, the recording as it was scored, never `trace_path`: the trace purge
// clears the path after 14 days, and a role correction must never lower a grade for that
// (ruling B6 r2). Per event only the measurements
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
  if (t.scoredWithoutTrace) out.push('no_trace');
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
  return tripMetrics(
    { distanceM: t.distanceM, durationS: t.durationS, role, rowsDigest: digest.data },
    storedDowngrades(t)
  );
}

/**
 * A stored event as the scorer takes it: the device's id, the measurements, the context.
 * `durationS` comes back from the stored `duration_ms`, which the upload contract pins to
 * `round(durationS × 1000)`: the re-score's duration factor can differ from the upload's by under
 * half a millisecond, which no score has ever turned on.
 */
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

/**
 * `disputed` is the writer's transient state for an accepted dispute whose recompute has not
 * landed; any recompute of the trip settles it to `removed`, so an event never stays in limbo
 * because a later action reached the trip before its own dispute was replayed.
 */
export function settleDisputed(events: readonly StoredEvent[]): StoredEvent[] {
  return events.map((e) => (e.status === 'disputed' ? { ...e, status: 'removed' } : e));
}

/** A speeding event at or beyond the severe threshold (§9.9), whatever its status. */
export function isSevereSpeeding(e: StoredEvent): boolean {
  return e.category === 'speeding' && Number(e.measured.overMps ?? 0) >= CONSTANTS.SEVERE_SPEEDING_OVER_MPS;
}

/**
 * The half of the severe flag the server can check (`hasSevereSpeeding` in events.ts, over stored
 * rows): a scored speeding event at or beyond the threshold. An L3 alert is the other half and only
 * the device knows it, so a caller lowers the stored flag only when the removed event was the
 * severe one.
 */
export function anySevereSpeeding(events: readonly StoredEvent[]): boolean {
  return events.some((e) => e.status === 'scored' && isSevereSpeeding(e));
}

/**
 * The trip's severe flag once `events` are settled, from the stored flag and what survives.
 *
 * Two halves make the stored flag (§9.9): a scored speeding event at or beyond the threshold,
 * which the server can see, and an L3 alert, which only the device knows. So the flag is at least
 * what the surviving scored events prove, and the device's half is kept — unless a severe event is
 * being settled by *this* recompute, whichever action accepted the dispute. That last clause is
 * what stops the flag outliving its event: when a dispute is accepted its event waits at
 * `disputed` until a recompute lands, and any recompute of the trip settles it (`settleDisputed`),
 * not only the dispute's own.
 */
export function severeAfter(events: readonly StoredEvent[], hadSevereEvent: boolean): boolean {
  return (
    anySevereSpeeding(settleDisputed(events)) ||
    (hadSevereEvent && !events.some((e) => e.status === 'disputed' && isSevereSpeeding(e)))
  );
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
  /** The severe flag after the action (re-derived by the caller when a dispute removed an event). */
  hadSevereEvent: boolean;
}

/**
 * The day rows and baselines as they stand once `trip` has `outcome`: the stored trips minus this
 * one, plus this one as it will be. The trip's own day always; today as well when the action
 * lands on a later day, so the long-term score moves today too (as finalize-trip does). Every
 * integer-bound field is rounded by `dayRows`, at the boundary, and nowhere else.
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
          hadSevereEvent: outcome.hadSevereEvent,
          phoneEvents: outcome.phoneEvents,
          cameraGood: trip.cameraSession,
        },
      ]
    : [];

  return {
    day: dayRows(days, [...ownDay, ...dayTrips], lt),
    baselines: baselines(allScored, nowMs),
  };
}
