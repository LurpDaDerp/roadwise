// trip-actions: what a user may do to a trip after it is stored (design §4.3, §7.D D3/D5, §9.9) —
// dispute an event, restate the role, delete the trip. Each action is one request from the
// device's queue, so every path is idempotent: a queued retry after a lost response answers with
// what the first attempt did (`replayed: true`) and finishes any recompute the first attempt did
// not land.
//
// The SQL writers own the rules (allowance, window, ownership, the status transitions); this
// function maps client ids to rows under the JWT's user, re-scores in TypeScript from the stored
// row and events (`_shared/rescore.ts`), rebuilds the user's day rows and baselines around the
// result, and hands everything to `apply_recompute`. The trace object is never read: re-scoring
// works from the stored events, so no rule here needs it (a `trace_unverified` path would sit in
// the dispute branch if one did). For a delete the object is removed first, then the row is
// soft-deleted: a trace must not outlive the user's decision even if the writer fails.
//
// Concurrency: two actions of one user that overlap (two devices) are last-writer-wins on
// `score_daily` and `baselines` for M2; the writers serialise the trip and event rows themselves.
// The device queue is sequential, so this is a race between devices only.
//
// Order of refusal, cheapest first: method, JWT, size, JSON, contract, then the one lookup that
// decides 404 / replay, then the writers. Structured logs carry ids and codes only (§4.7).
import { StorageFailure } from '../_shared/actions_db.ts';
import type { ActionsDb, RecomputeResult, StoredEvent, StoredTrip } from '../_shared/actions_db.ts';
import {
  bearerToken,
  invalidPayload,
  json,
  pgFailure,
  readJsonBody,
  requestId,
  requirePost,
  type Logger,
} from '../_shared/http.ts';
import { isPgError } from '../_shared/pg.ts';
import { aggregatesAfter, eventRows, storedDowngrades, storedMetrics, toScorableEvent } from '../_shared/rescore.ts';
import { scoreTrip } from '../_shared/scoring/index';
import type { TripMetrics } from '../_shared/scoring/index';
import { TripActionSchema, type DeleteAction, type DisputeAction, type SetRoleAction } from './schema.ts';

/** An action body is a few ids and a note; anything larger is not one. */
export const MAX_BODY_BYTES = 16_384;
/** Denied disputes a user may record per rolling day before the writer stops being called (429). */
export const MAX_DENIED_PER_DAY = 20;

const DAY_MS = 86_400_000;

/** The writer's bad-input refusals that are the client's to act on, not drift: 422 with a code. */
const INPUT_REFUSALS: Record<string, string> = {
  'trip is not scored': 'trip_not_scored',
  'event is not scored': 'event_not_scored',
  'dispute window closed': 'dispute_window_closed',
};

export interface ActionsDeps {
  /** The user id the token proves, or null when it proves nothing. */
  verifyJwt(token: string): Promise<string | null>;
  db: ActionsDb;
  now?: () => number;
  log?: Logger;
}

export interface DisputeResponse {
  tripId: string;
  score: number | null;
  status: string;
  autoAccepted: boolean;
  /** `least(remaining_7d, remaining_30d)` after this dispute. */
  remainingAllowance: number;
  /** Why the dispute was not applied, or null. */
  reason: 'allowance_7d' | 'allowance_30d' | null;
  replayed: boolean;
}

export interface SetRoleResponse {
  tripId: string;
  role: string;
  score: number | null;
  status: string;
  replayed: boolean;
}

export interface DeleteResponse {
  tripId: string;
  deleted: true;
  replayed: boolean;
}

/** A stored row this function cannot work from; logged, answered 500 with the code. */
class IntegrityFailure extends Error {
  constructor(readonly code: 'rows_digest_invalid') {
    super(code);
    this.name = 'IntegrityFailure';
  }
}

interface Ctx {
  requestId: string;
  action: string;
  clientTripId?: string;
  clientEventId?: string;
}

/** The trace object key, derived exactly as `apply_trip` stores it — never from a stored column. */
const traceKey = (userId: string, clientTripId: string) => `${userId}/${clientTripId}.bin.gz`;

function failure(err: unknown, log: Logger, ctx: Ctx): Response {
  if (err instanceof StorageFailure) {
    log.error('trip-actions storage failure', { ...ctx, message: err.message });
    return json(503, { code: 'retry' }, { 'retry-after': '2' });
  }
  if (err instanceof IntegrityFailure) {
    log.error(`trip-actions ${err.code}`, ctx);
    return json(500, { code: err.code });
  }
  if (isPgError(err)) {
    if (err.code === '22023' && INPUT_REFUSALS[err.message]) return json(422, { code: INPUT_REFUSALS[err.message] });
    if (err.code === '42501' && err.message === 'trip already deleted') return json(409, { code: 'trip_deleted' });
  }
  return pgFailure(err, log, ctx, 'trip-actions');
}

interface Run {
  deps: ActionsDeps;
  db: ActionsDb;
  log: Logger;
  nowMs: number;
  userId: string;
  ctx: Ctx;
}

/**
 * Score the trip again from the stored row under `role` and `events` (statuses already as they
 * should be), rebuild the aggregates around the result, and apply it all in one writer call.
 */
async function rescore(run: Run, trip: StoredTrip, role: TripMetrics['role'], events: StoredEvent[]): Promise<RecomputeResult> {
  const metrics = storedMetrics(trip, role);
  if (!metrics) throw new IntegrityFailure('rows_digest_invalid');
  const scored = scoreTrip(metrics, events.map(toScorableEvent));
  if (scored.dataQuality !== trip.dataQuality) {
    run.log.warn('trip-actions quality re-derived differently', {
      ...run.ctx,
      tripId: trip.id,
      stored: trip.dataQuality,
      derived: scored.dataQuality,
      downgrades: storedDowngrades(trip),
    });
  }
  const aggregates = await aggregatesAfter(run.db, run.userId, run.nowMs, trip, {
    score: scored.score,
    status: scored.status,
    exposure: scored.exposure,
    categoryDeductions: scored.categoryDeductions,
    phoneEvents: events.filter((e) => e.category === 'phone' && e.status === 'scored').length,
  });
  return run.db.applyRecompute({
    userId: run.userId,
    tripId: trip.id,
    scored,
    events: eventRows(events, scored),
    day: aggregates.day,
    baselines: aggregates.baselines,
  });
}

async function dispute(run: Run, a: DisputeAction): Promise<Response> {
  const { db, userId } = run;
  const found = await db.findEvent(userId, a.clientEventId);
  if (found.kind === 'none') return json(404, { code: 'not_found' });
  if (found.kind === 'many') {
    // the device reused an id across trips; refusing is safer than guessing which one
    run.log.error('trip-actions client event id is not unique for the user', run.ctx);
    return json(409, { code: 'ambiguous_event' });
  }
  const event = found.event;
  const trip = await db.findTripById(userId, event.tripId);
  if (!trip) return json(404, { code: 'not_found' });

  // The draft's pre-check. Its verdict also decides whether the denied-request cap needs
  // counting: only a dispute that will be denied adds a denied audit row.
  const preview = await db.countDisputeAllowance(userId);

  if (trip.deletedAt !== null) {
    // a queued dispute for a trip the user deleted meanwhile: nothing to apply, nothing to record
    const replay: DisputeResponse = {
      tripId: trip.id,
      score: trip.score,
      status: trip.status,
      autoAccepted: false,
      remainingAllowance: preview.remaining_allowance,
      reason: null,
      replayed: true,
    };
    return json(200, replay);
  }

  if (!preview.can_auto_accept) {
    const denied = await db.countDeniedDisputes(userId, run.nowMs - DAY_MS);
    if (denied >= MAX_DENIED_PER_DAY) return json(429, { code: 'too_many_disputes' });
  }

  const decision = await db.recordDispute(userId, event.id, a.reason, a.note ?? null, a.statedLimitMph ?? null);

  let score = trip.score;
  let status = trip.status;
  // An accepted dispute leaves the event `disputed` until the recompute stores it as `removed`; a
  // replay whose event is already `removed` was finished the first time.
  if (decision.auto_accepted && decision.event_status !== 'removed') {
    const events = (await db.listTripEvents(trip.id)).map((e) => (e.id === event.id ? { ...e, status: 'removed' } : e));
    const result = await rescore(run, trip, trip.role, events);
    score = result.score;
    status = result.status;
  }
  const response: DisputeResponse = {
    tripId: trip.id,
    score,
    status,
    autoAccepted: decision.auto_accepted,
    remainingAllowance: decision.remaining_allowance,
    reason: decision.denied_reason,
    replayed: decision.replayed,
  };
  return json(200, response);
}

async function setRole(run: Run, a: SetRoleAction): Promise<Response> {
  const { db, userId } = run;
  const trip = await db.findTripRow(userId, a.clientTripId);
  if (!trip) return json(404, { code: 'not_found' });
  if (trip.deletedAt !== null) {
    const replay: SetRoleResponse = { tripId: trip.id, role: trip.role, score: trip.score, status: trip.status, replayed: true };
    return json(200, replay);
  }
  const set = await db.setTripRole(userId, trip.id, a.role);
  // The writer has already unscored a passenger/other trip; the recompute writes the same result
  // (the scorer's own `unscored` / `passenger`) and refreshes the day rows and baselines, so both
  // roles go through the one path.
  const result = await rescore(run, trip, a.role, await db.listTripEvents(trip.id));
  const response: SetRoleResponse = {
    tripId: trip.id,
    role: set.role,
    score: result.score,
    status: result.status,
    replayed: false,
  };
  return json(200, response);
}

async function deleteTrip(run: Run, a: DeleteAction): Promise<Response> {
  const { db, userId } = run;
  const trip = await db.findTripRow(userId, a.clientTripId);
  if (!trip) return json(404, { code: 'not_found' });
  // Privacy first: the object goes before the row, and always by the derived key — the stored
  // column may already be cleared by an earlier attempt whose response was lost.
  await db.removeTrace(traceKey(userId, trip.clientTripId));
  const deleted = await db.softDeleteTrip(userId, trip.id);
  // Refreshed on a replay too: the first attempt may have died between the delete and this.
  const aggregates = await aggregatesAfter(db, userId, run.nowMs, trip, null);
  await db.applyRecompute({
    userId,
    tripId: trip.id,
    scored: null,
    events: null,
    day: aggregates.day,
    baselines: aggregates.baselines,
  });
  const response: DeleteResponse = { tripId: trip.id, deleted: true, replayed: deleted.replayed };
  return json(200, response);
}

export async function handleTripAction(req: Request, deps: ActionsDeps): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const id = requestId();

  const wrongMethod = requirePost(req);
  if (wrongMethod) return wrongMethod;

  const token = bearerToken(req);
  const userId = token ? await deps.verifyJwt(token) : null;
  if (!userId) return json(401, { code: 'unauthorized' });

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = TripActionSchema.safeParse(body.body);
  if (!parsed.success) return invalidPayload(parsed.error);
  const action = parsed.data;

  const ctx: Ctx = { requestId: id, action: action.action };
  if (action.action === 'dispute') ctx.clientEventId = action.clientEventId;
  else ctx.clientTripId = action.clientTripId;
  const nowMs = now();
  const run: Run = { deps, db: deps.db, log, nowMs, userId, ctx };

  try {
    switch (action.action) {
      case 'dispute':
        return await dispute(run, action);
      case 'set-role':
        return await setRole(run, action);
      case 'delete':
        return await deleteTrip(run, action);
    }
  } catch (err) {
    return failure(err, log, ctx);
  }
}
