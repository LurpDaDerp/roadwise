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
// else (§4.7); the per-event derived fields and the severe flag are recomputed before storage.
//
// The HTTP plumbing and the SQLSTATE mapping below are finalize-shaped copies; Task 2b lifts them
// into `_shared/http.ts` / `_shared/pg.ts`, and this file switches to those once they land.
import {
  baselines,
  dayRows,
  emptyDayRow,
  isNightAt,
  localDay,
  type DayRow,
  type DayTripInput,
} from '../_shared/aggregate.ts';
import { PgError, type ApplyTripEnvelope, type Db } from '../_shared/db.ts';
import { countDerivedDrift, deriveEvents, hasSevereSpeeding } from '../_shared/events.ts';
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
/** Lock timeout, deadlock, serialization failure: the client should simply try again. */
const RETRYABLE = new Set(['55P03', '40P01', '40001']);
/** Table CHECKs, keys and casts on the event rows: zod and plausibility refuse these first, so this is drift. */
const ROW_CODES = new Set(['23514', '23505', '22P02', '23502', '22003']);

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
  /** The trip's own day row, exactly as written; the device caches it as the authoritative day. */
  day: DayRow;
  provisionalMismatch: boolean;
  replayed: boolean;
}

/** Log context: a server-generated request id (never the caller's header) and the trip's client id. */
interface Ctx {
  requestId: string;
  clientTripId: string;
}

const json = (status: number, body: unknown, headers: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The body, bounded: refused on a declared length over the cap without reading, and cut off at the
 * cap while streaming so a chunked upload cannot buffer more than that. Null means too large.
 */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length')) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The device's score against the server's: a different status, or a score more than the tolerance off. */
function compare(device: ScoredTrip, server: ScoredTrip): { mismatch: boolean; delta: number | null } {
  const delta =
    device.score !== null && server.score !== null ? Math.abs(device.score - server.score) : null;
  const mismatch = device.status !== server.status || (delta !== null && delta > MISMATCH_TOLERANCE);
  return { mismatch, delta };
}

/**
 * The SQLSTATE mapping (readiness item 5, addendum 3). Bodies carry the mapped code only; the
 * database's message goes to the log, never to the caller.
 */
function failure(err: unknown, log: Logger, ctx: Ctx & { tz: string }, headers: Record<string, string>): Response {
  if (err instanceof PgError) {
    if (RETRYABLE.has(err.code)) return json(503, { code: 'retry' }, { ...headers, 'retry-after': '2' });
    if (err.code === '22023') {
      log.error('finalize-trip envelope refused', { ...ctx, message: err.message });
      return json(400, { code: 'invalid_envelope' }, headers);
    }
    if (ROW_CODES.has(err.code)) {
      log.error('finalize-trip event rows refused', { ...ctx, code: err.code, message: err.message });
      return json(400, { code: 'invalid_event_rows' }, headers);
    }
    if (err.code === '42501') {
      log.error('finalize-trip refused by the writer', { ...ctx, message: err.message });
      return err.message.includes('requires the service role')
        ? json(500, { code: 'misconfigured' }, headers)
        : json(403, { code: 'forbidden' }, headers);
    }
    log.error('finalize-trip database failure', { ...ctx, code: err.code, message: err.message });
    return json(500, { code: 'internal' }, headers);
  }
  log.error('finalize-trip failed', { ...ctx, error: err instanceof Error ? err.message : String(err) });
  return json(500, { code: 'internal' }, headers);
}

export async function handleFinalizeTrip(req: Request, deps: FinalizeDeps): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  // Generated here, returned to the caller, never taken from a header (a client could collide or
  // spoof it). Structured logs carry it and the trip's client id, never a position or a name.
  const requestId = crypto.randomUUID();
  const headers = { 'x-request-id': requestId };
  const reply = (status: number, body: unknown) => json(status, body, headers);

  if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' }, { ...headers, allow: 'POST' });

  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const userId = bearer ? await deps.verifyJwt(bearer[1]) : null;
  if (!userId) return reply(401, { code: 'unauthorized' });

  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) return reply(413, { code: 'payload_too_large' });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return reply(400, { code: 'invalid_json' });
  }

  const parsed = FinalizeTripPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return reply(400, {
      code: 'invalid_payload',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const p = parsed.data;
  const ctx = { requestId, clientTripId: p.clientTripId, tz: p.tz };
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
        return reply(500, { code: 'trace_path_mismatch' });
      }
      const replay: FinalizeTripResponse = {
        tripId: existing.id,
        score: existing.score,
        status: existing.status,
        day: (await deps.db.getDayRow(userId, existing.localDay)) ?? emptyDayRow(existing.localDay),
        provisionalMismatch: false,
        replayed: true,
      };
      return reply(200, replay);
    }

    const nowMs = now();
    const plausible = checkPlausibility(p, nowMs);
    if (!plausible.ok) return reply(400, plausible.failure);

    if ((await deps.db.countTripsSince(userId, nowMs - DAY_MS)) >= MAX_TRIPS_PER_24H) {
      return reply(429, { code: 'too_many_trips' });
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

    // What is stored per event is the server's arithmetic over the event's inputs, and the severe
    // flag is at least what the scored speeding events prove.
    const events = deriveEvents(p.events, scored);
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
      conditions: { night: isNightAt(p.startedAt, p.tz), precipitation: false },
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
    return reply(200, response);
  } catch (err) {
    return failure(err, log, ctx, headers);
  }
}
