// finalize-trip: the server side of the device's upload (design §4.4).
//
// The device has already scored the trip; the server's job is to refuse what cannot be true, score
// it again with the same package so the stored result is the server's, fold it into the user's
// aggregates, and hand everything to `apply_trip` in one call. Nothing is read from storage: the
// trace follows the summary later (over Wi-Fi, as its own queue item) and is only consumed when a
// dispute needs it, so the score here rests on the payload's events alone.
//
// Order of work, cheapest refusal first: method, JWT, size, JSON, contract, plausibility, then the
// one lookup that can short-circuit (a replay), the daily cap, and the aggregates. A user id is
// taken from the JWT and nowhere else (§4.7).
import { baselines, dayRows, isNightAt, localDay, type DayTripInput } from '../_shared/aggregate.ts';
import { PgError, type ApplyTripEnvelope, type Db } from '../_shared/db.ts';
import { FinalizeTripPayloadSchema } from '../_shared/payload.ts';
import { checkPlausibility, tripMetrics } from '../_shared/plausibility.ts';
import { CONSTANTS, longTermScore, scoreTrip } from '../_shared/scoring/index';
import type { ScoredTrip } from '../_shared/scoring/index';

export const MAX_BODY_BYTES = 1_048_576;
/** Trips a user may hold on today's local day (in the payload's zone); the 201st upload is refused. */
export const MAX_TRIPS_PER_DAY = 200;
/** A device score further than this from the server's is logged as a mismatch. */
export const MISMATCH_TOLERANCE = 2;

const DAY_MS = 86_400_000;
/** Lock timeout, deadlock, serialization failure: the client should simply try again. */
const RETRYABLE = new Set(['55P03', '40P01', '40001']);
/** Table CHECKs and keys on the event rows: zod refuses these first, so this is drift. */
const ROW_CODES = new Set(['23514', '23505', '22P02', '23502']);

export interface Logger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

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
  /** The trip's local day, `YYYY-MM-DD`. */
  day: string;
  provisionalMismatch: boolean;
  replayed: boolean;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The device's score against the server's: a different status, or a score more than the tolerance off. */
function compare(device: ScoredTrip, server: ScoredTrip): { mismatch: boolean; delta: number | null } {
  const delta =
    device.score !== null && server.score !== null ? Math.abs(device.score - server.score) : null;
  const mismatch = device.status !== server.status || (delta !== null && delta > MISMATCH_TOLERANCE);
  return { mismatch, delta };
}

function failure(err: unknown, log: Logger, ctx: { requestId: string; clientTripId: string }): Response {
  if (err instanceof PgError) {
    if (RETRYABLE.has(err.code)) return json(503, { code: 'retry' }, { 'retry-after': '2' });
    if (err.code === '22023') {
      log.error('finalize-trip envelope refused', { ...ctx, message: err.message });
      return json(400, { code: 'invalid_envelope', message: err.message });
    }
    if (ROW_CODES.has(err.code)) {
      log.error('finalize-trip event rows refused', { ...ctx, code: err.code, message: err.message });
      return json(400, { code: 'invalid_event_rows', message: err.message });
    }
    if (err.code === '42501') {
      log.error('finalize-trip refused by the writer', { ...ctx, message: err.message });
      return err.message.includes('requires the service role')
        ? json(500, { code: 'misconfigured' })
        : json(403, { code: 'forbidden' });
    }
    log.error('finalize-trip database failure', { ...ctx, code: err.code, message: err.message });
    return json(500, { code: 'internal' });
  }
  log.error('finalize-trip failed', { ...ctx, error: err instanceof Error ? err.message : String(err) });
  return json(500, { code: 'internal' });
}

export async function handleFinalizeTrip(req: Request, deps: FinalizeDeps): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  // Structured logs carry the gateway's request id (§4.7), never a position or a name.
  const requestId = req.headers.get('x-request-id') ?? req.headers.get('sb-request-id') ?? crypto.randomUUID();

  if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' }, { allow: 'POST' });

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const userId = bearer ? await deps.verifyJwt(bearer[1]) : null;
  if (!userId) return json(401, { code: 'unauthorized' });

  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) {
    return json(413, { code: 'payload_too_large' });
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { code: 'payload_too_large' });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { code: 'invalid_json' });
  }

  const parsed = FinalizeTripPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, {
      code: 'invalid_payload',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const p = parsed.data;

  const plausible = checkPlausibility(p);
  if (!plausible.ok) return json(400, plausible.failure);

  const tripDay = localDay(p.startedAt, p.tz);
  const ctx = { requestId, clientTripId: p.clientTripId };
  // Derived here as `apply_trip` derives it; the field in the payload only says whether one exists.
  const traceKey = `${userId}/${p.clientTripId}.bin.gz`;

  try {
    // A replay (lost response, queue retry) answers from what is stored — even after the user has
    // deleted the trip since — and never re-runs the aggregates.
    const existing = await deps.db.findTrip(userId, p.clientTripId);
    if (existing) {
      if (existing.tracePath !== null && existing.tracePath !== traceKey) {
        log.error('finalize-trip stored trace_path is not the derived key', { ...ctx, tripId: existing.id });
        return json(500, { code: 'trace_path_mismatch' });
      }
      const replay: FinalizeTripResponse = {
        tripId: existing.id,
        score: existing.score,
        status: existing.status,
        day: existing.localDay,
        provisionalMismatch: false,
        replayed: true,
      };
      return json(200, replay);
    }

    const nowMs = now();
    const today = localDay(nowMs, p.tz);
    if ((await deps.db.countTripsOnDay(userId, today)) >= MAX_TRIPS_PER_DAY) {
      return json(429, { code: 'too_many_trips' });
    }

    // The server's score is the one stored; the device's is only checked against it.
    const scored = scoreTrip(tripMetrics(p, plausible.downgrades), p.events);
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
    const days = today === tripDay ? [tripDay] : [tripDay, today];
    const dayTrips = await deps.db.listDayTrips(userId, days);
    const ownDay: DayTripInput = {
      localDay: tripDay,
      score: scored.score,
      status: scored.status,
      durationS: p.durationS,
      exposure: scored.exposure,
      hadSevereEvent: p.hadSevereEvent,
      phoneEvents: p.events.filter((e) => e.category === 'phone' && e.status === 'scored').length,
      cameraGood: p.cameraSession,
    };

    const envelope: ApplyTripEnvelope = {
      userId,
      payload: p,
      scored,
      day: dayRows(days, [ownDay, ...dayTrips], lt),
      baselines: baselines(allScored, nowMs),
      conditions: { night: isNightAt(p.startedAt, p.tz), precipitation: false },
      limitCoveragePct: null,
    };
    const result = await deps.db.applyTrip(envelope);
    const response: FinalizeTripResponse = {
      tripId: result.trip_id,
      score: result.score,
      status: result.status,
      day: result.day,
      provisionalMismatch: mismatch,
      replayed: result.replayed,
    };
    return json(200, response);
  } catch (err) {
    return failure(err, log, ctx);
  }
}
