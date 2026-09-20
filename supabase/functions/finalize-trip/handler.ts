// finalize-trip: the server side of the device's upload (design §4.4).
//
// The device has already scored the trip; the server's job is to refuse what cannot be true, score
// it again with the same package so the stored result is the server's, fold it into the user's
// aggregates, and hand everything to `apply_trip` in one call. Nothing is read from storage: the
// trace follows the summary later (over Wi-Fi, as its own queue item) and is only consumed when a
// dispute needs it, so the score here rests on the payload's events alone.
//
// Order of work, cheapest refusal first: method, JWT, size, JSON, contract, then the one lookup
// that can short-circuit (a replay is answered from the store whatever today's rules say),
// plausibility, the 24-hour cap, and the aggregates. A user id is taken from the JWT and nowhere
// else (§4.7); night, the per-event derived fields and the severe flag are the server's.
import {
  baselines,
  dayRows,
  emptyDayRow,
  isNightAt,
  localDay,
  type DayRow,
  type DayTripInput,
} from '../_shared/aggregate.ts';
import type { ApplyTripEnvelope, Db } from '../_shared/db.ts';
import { countDerivedDrift, deriveEvents, hasSevereSpeeding, withTripNight } from '../_shared/events.ts';
import {
  bearerToken,
  invalidPayload,
  json,
  pgFailure,
  readJsonBody,
  requestId,
  requirePost,
  withRequestId,
  type Logger,
} from '../_shared/http.ts';
import { FinalizeTripPayloadSchema } from '../_shared/payload.ts';
import { checkPlausibility, tripMetrics } from '../_shared/plausibility.ts';
import { CONSTANTS, longTermScore, scoreTrip } from '../_shared/scoring/index';
import type { ScoredTrip } from '../_shared/scoring/index';

export const MAX_BODY_BYTES = 1_048_576;
/** Uploads a user may make in any rolling 24 hours; the next one is refused (brief: 429 above 200/day). */
export const MAX_TRIPS_PER_24H = 200;
/** A device score further than this from the server's is logged as a mismatch. */
export const MISMATCH_TOLERANCE = 2;

const DAY_MS = 86_400_000;

export interface FinalizeDeps {
  /** The user id the token proves, or null when it proves nothing. */
  verifyJwt(token: string): Promise<string | null>;
  db: Db;
  now?: () => number;
  log?: Logger;
}

export interface FinalizeTripResponse {
  tripId: string;
  score: number | null;
  status: string;
  /** The trip's own day row, exactly as written; the device caches it as the authoritative day. */
  day: DayRow;
  provisionalMismatch: boolean;
  replayed: boolean;
}

/** The device's score against the server's: a different status, or a score more than the tolerance off. */
function compare(device: ScoredTrip, server: ScoredTrip): { mismatch: boolean; delta: number | null } {
  const delta =
    device.score !== null && server.score !== null ? Math.abs(device.score - server.score) : null;
  const mismatch = device.status !== server.status || (delta !== null && delta > MISMATCH_TOLERANCE);
  return { mismatch, delta };
}

export async function handleFinalizeTrip(req: Request, deps: FinalizeDeps): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const id = requestId();
  const reply = (res: Response) => withRequestId(res, id);

  const wrongMethod = requirePost(req);
  if (wrongMethod) return reply(wrongMethod);

  const token = bearerToken(req);
  const userId = token ? await deps.verifyJwt(token) : null;
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = FinalizeTripPayloadSchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const p = parsed.data;
  // Structured logs carry these and codes; never a position or a name. `tz` is there so a zone
  // Intl knows and Postgres does not (a 22023 from the writer) is visible to an operator.
  const ctx = { requestId: id, clientTripId: p.clientTripId, tz: p.tz };
  // Derived here as `apply_trip` derives it; the field in the payload only says whether one exists.
  const traceKey = `${userId}/${p.clientTripId}.bin.gz`;

  try {
    // A replay (lost response, queue retry) answers from what is stored — even after the user has
    // deleted the trip since, and even if today's plausibility rules would refuse the payload —
    // and never re-runs the aggregates.
    const existing = await deps.db.findTrip(userId, p.clientTripId);
    if (existing) {
      if (existing.tracePath !== null && existing.tracePath !== traceKey) {
        log.error('finalize-trip stored trace_path is not the derived key', { ...ctx, tripId: existing.id });
        return reply(json(500, { code: 'trace_path_mismatch' }));
      }
      const replay: FinalizeTripResponse = {
        tripId: existing.id,
        score: existing.score,
        status: existing.status,
        day: (await deps.db.getDayRow(userId, existing.localDay)) ?? emptyDayRow(existing.localDay),
        provisionalMismatch: false,
        replayed: true,
      };
      return reply(json(200, replay));
    }

    const nowMs = now();
    const plausible = checkPlausibility(p, nowMs);
    if (!plausible.ok) return reply(json(400, plausible.failure));

    if ((await deps.db.countTripsSince(userId, nowMs - DAY_MS)) >= MAX_TRIPS_PER_24H) {
      return reply(json(429, { code: 'too_many_trips' }));
    }

    // Night is the clock rule at trip start in the trip's zone, for every event and for the trip;
    // the device's per-event flag is a scoring input it does not get to choose.
    const night = isNightAt(p.startedAt, p.tz);
    const inputs = withTripNight(p.events, night);

    // The server's score is the one stored; the device's is only checked against it.
    const scored = scoreTrip(tripMetrics(p, plausible.downgrades), inputs);
    const { mismatch, delta } = compare(p.provisional, scored);
    if (mismatch) {
      log.warn('finalize-trip mismatch', {
        ...ctx,
        delta,
        device: { score: p.provisional.score, status: p.provisional.status },
        server: { score: scored.score, status: scored.status },
        downgrades: plausible.downgrades,
      });
    }

    // What is stored per event is the server's arithmetic over the event's inputs, and the severe
    // flag is at least what the scored speeding events prove.
    const events = deriveEvents(inputs, scored);
    const hadSevereEvent = p.hadSevereEvent || hasSevereSpeeding(events);
    const drifted = countDerivedDrift(p.events, events);
    if (drifted > 0 || hadSevereEvent !== p.hadSevereEvent) {
      log.warn('finalize-trip derived fields corrected', {
        ...ctx,
        events: drifted,
        hadSevereEvent: hadSevereEvent !== p.hadSevereEvent,
      });
    }
    const payload = { ...p, events, hadSevereEvent };

    const tripDay = localDay(p.startedAt, p.tz);
    const stored = await deps.db.listScoredTrips(userId, nowMs - CONSTANTS.LONG_TERM_MAX_D * DAY_MS);
    const own =
      scored.status === 'final' && scored.score !== null
        ? [
            {
              endedAt: p.endedAt,
              score: scored.score,
              exposure: scored.exposure,
              durationS: p.durationS,
              categoryDeductions: scored.categoryDeductions,
            },
          ]
        : [];
    const allScored = [...own, ...stored];
    const lt = longTermScore(allScored, nowMs);

    // The trip's own day always; today's as well when the trip is being synced late, so the
    // long-term score moves today and not only on the day the trip happened.
    const today = localDay(nowMs, p.tz);
    const days = today === tripDay ? [tripDay] : [tripDay, today];
    const dayTrips = await deps.db.listDayTrips(userId, days);
    const ownDay: DayTripInput = {
      localDay: tripDay,
      score: scored.score,
      status: scored.status,
      durationS: p.durationS,
      exposure: scored.exposure,
      hadSevereEvent,
      phoneEvents: events.filter((e) => e.category === 'phone' && e.status === 'scored').length,
      cameraGood: p.cameraSession,
    };

    const envelope: ApplyTripEnvelope = {
      userId,
      payload,
      scored,
      day: dayRows(days, [ownDay, ...dayTrips], lt),
      baselines: baselines(allScored, nowMs),
      conditions: { night, precipitation: false },
      limitCoveragePct: null,
    };
    const result = await deps.db.applyTrip(envelope);
    // The loser of a concurrent first upload gets the winner's stored day, not its own attempt.
    const day = result.replayed
      ? ((await deps.db.getDayRow(userId, result.day)) ?? emptyDayRow(result.day))
      : envelope.day[0];
    const response: FinalizeTripResponse = {
      tripId: result.trip_id,
      score: result.score,
      status: result.status,
      day,
      provisionalMismatch: mismatch,
      replayed: result.replayed,
    };
    return reply(json(200, response));
  } catch (err) {
    return reply(pgFailure(err, log, ctx, 'finalize-trip'));
  }
}
