// trip-actions: what a user may do to a trip after it is stored (design §4.3, §7.D D3/D5, §9.9) —
// dispute an event, restate the role, delete the trip. Each action is one request from the
// device's queue, so every path is idempotent: a queued retry after a lost response answers with
// what the first attempt did (`replayed: true`) and finishes any recompute the first attempt did
// not land.
//
// The SQL writers own the rules (allowance, window, ownership, the status transitions); this
// function maps client ids to rows under the JWT's user, re-scores in TypeScript from the stored
// row and events (`_shared/rescore.ts`), rebuilds the user's day rows and baselines around the
// result, and hands everything to `apply_recompute`. The severe flag is re-derived by every
// recompute, not only the dispute's own: whichever action settles the disputed event lowers the
// flag with it (`severeAfter`), and the device's own half survives anything else. The
// trace object is never read: re-scoring works from the stored events, so no rule here needs it
// (a `trace_unverified` path would sit in the dispute branch if one did). For a delete the object
// is removed first, then the row is soft-deleted: a trace must not outlive the user's decision
// even if the writer fails.
//
// Every 200 carries `days`: the day rows this call wrote (or, when nothing was recomputed, the
// stored row of the trip's day), so the device can cache the authoritative day as it does after
// finalize-trip.
//
// Concurrency: two actions of one user that overlap (two devices) are last-writer-wins on
// `score_daily` and `baselines` for M2; the writers serialise the trip and event rows themselves.
// The device queue is sequential, so this is a race between devices only. On the trip row itself
// the same window covers `had_severe_event` alongside `score`, `status` and `category_deductions`:
// each is re-derived from the rows this call read, so the later writer's values stand whether or
// not it saw the earlier one's. Both derive the flag by the same rule (`severeAfter`), so the
// loser's value differs only by what it had read, and the next recompute of the trip settles it.
//
// Scoring versions (M2 final review M-5): a re-score runs the scorer of the version the trip was
// first scored under (`trips.scoring_version`), looked up in `SCORERS`, never whatever is deployed;
// the scoring explainer promises that a model change leaves already-scored trips as they were. A
// trip whose version has no scorer here is refused 409 `scoring_version_unsupported` before any
// writer runs, and `apply_recompute` backs this up by refusing a result under any other version.
// Delete re-scores nothing and is never refused for it.
//
// Order of refusal, cheapest first: method, JWT, size, JSON, contract, then the one lookup that
// decides 404 / replay, the stored digest and the stored scoring version (so a row this function
// cannot score fails before anything is written), then the writers. Structured logs carry ids and
// codes only (§4.7).
import { emptyDayRow, type DayRow, type TripFields } from '../_shared/aggregate.ts';
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
  withRequestId,
  type Logger,
} from '../_shared/http.ts';
import { isPgError } from '../_shared/pg.ts';
import {
  aggregatesAfter,
  eventRows,
  settleDisputed,
  severeAfter,
  storedDowngrades,
  storedMetrics,
  toScorableEvent,
} from '../_shared/rescore.ts';
import { scoreTrip } from '../_shared/scoring/index';
import type { TripMetrics } from '../_shared/scoring/index';
import { TripActionSchema, type DeleteAction, type DisputeAction, type SetRoleAction } from './schema.ts';

/**
 * The scorer for each scoring version a stored trip can carry. A new model version adds an entry
 * (its own copy of the scorer) and keeps every older one, so a dispute or a role answer on an old
 * trip is re-scored under the rules that trip was scored by.
 */
export const SCORERS: Record<number, typeof scoreTrip> = { 1: scoreTrip };

/** An action body is a few ids and a note; anything larger is not one. */
export const MAX_BODY_BYTES = 16_384;
/** Denied disputes a user may record per rolling day before the writer stops being called (429). */
export const MAX_DENIED_PER_DAY = 20;
/** What the 429 tells the queue: the denials age out of the rolling day one at a time. */
export const RETRY_AFTER_DENIED_S = 3600;

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
  /** The trip's severe flag after the dispute, for the device's own `conditions`. */
  hadSevereEvent: boolean;
  /**
   * What this call left on the trip beyond the score: the per-category breakdown, the exposure,
   * the data-quality grade and the limit coverage. `apply_recompute` rewrites all of them, and
   * without them on the wire the device's own copy stays as its finalizer wrote it — which is
   * what makes D2's bars, D1's highlight, the coaching tip and every insight rate keep charging
   * points an accepted dispute has already removed.
   */
  trip: TripFields;
  /** The day rows this call wrote (the trip's day, plus today when later); stored row when nothing was recomputed. */
  days: DayRow[];
  replayed: boolean;
}

export interface SetRoleResponse {
  tripId: string;
  role: string;
  score: number | null;
  status: string;
  /** As on a dispute: what the re-score left on the trip beyond the score. */
  trip: TripFields;
  days: DayRow[];
  replayed: boolean;
}

export interface DeleteResponse {
  tripId: string;
  deleted: true;
  days: DayRow[];
  replayed: boolean;
}

/** A stored row this function cannot work from; logged, answered 500 with the code. */
class IntegrityFailure extends Error {
  constructor(readonly code: 'rows_digest_invalid') {
    super(code);
    this.name = 'IntegrityFailure';
  }
}

/** A stored trip scored under a version this deployment has no scorer for; answered 409. */
class VersionUnsupported extends Error {
  constructor(readonly tripId: string, readonly scoringVersion: number) {
    super('scoring_version_unsupported');
    this.name = 'VersionUnsupported';
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
  if (err instanceof VersionUnsupported) {
    // Not the client's to fix and not transient: an operator has to ship that version's scorer.
    log.error('trip-actions scoring version unsupported', {
      ...ctx,
      tripId: err.tripId,
      scoringVersion: err.scoringVersion,
    });
    return json(409, { code: 'scoring_version_unsupported' });
  }
  if (isPgError(err)) {
    if (err.code === '22023' && err.message === 'scoring_version_mismatch') {
      // The writer's backstop to `requireScorer`; reachable only if the two ever disagree.
      log.error('trip-actions scoring version refused by the writer', ctx);
      return json(409, { code: 'scoring_version_unsupported' });
    }
    if (err.code === '22023' && INPUT_REFUSALS[err.message]) return json(422, { code: INPUT_REFUSALS[err.message] });
    if (err.code === '42501' && err.message === 'trip already deleted') return json(409, { code: 'trip_deleted' });
  }
  return pgFailure(err, log, ctx, 'trip-actions');
}

interface Run {
  db: ActionsDb;
  log: Logger;
  nowMs: number;
  userId: string;
  ctx: Ctx;
}

/** The scorer's inputs from the row, or the integrity failure — checked before anything is written. */
function requireMetrics(trip: StoredTrip, role: TripMetrics['role']): TripMetrics {
  const metrics = storedMetrics(trip, role);
  if (!metrics) throw new IntegrityFailure('rows_digest_invalid');
  return metrics;
}

/** The scorer of the version the trip was stored under, or the 409; checked before anything is written. */
function requireScorer(trip: StoredTrip): typeof scoreTrip {
  const scorer = Object.hasOwn(SCORERS, trip.scoringVersion) ? SCORERS[trip.scoringVersion] : undefined;
  if (!scorer) throw new VersionUnsupported(trip.id, trip.scoringVersion);
  return scorer;
}

/** The trip fields as stored, for a reply that recomputed nothing. */
const storedFields = (trip: StoredTrip, hadSevereEvent = trip.hadSevereEvent): TripFields => ({
  categoryDeductions: trip.categoryDeductions,
  exposure: trip.exposure,
  dataQuality: trip.dataQuality,
  hadSevereEvent,
  limitCoveragePct: trip.limitCoveragePct,
});

/** The stored row of the trip's day (or an empty one), for a reply that recomputed nothing. */
async function storedDays(run: Run, trip: StoredTrip): Promise<DayRow[]> {
  return [(await run.db.getDayRow(run.userId, trip.localDay)) ?? emptyDayRow(trip.localDay)];
}

interface Recomputed {
  result: RecomputeResult;
  days: DayRow[];
  /** The severe flag this recompute stored, re-derived from the stored flag and what survives. */
  hadSevereEvent: boolean;
  /** The trip fields this recompute stored, for the device's row to follow. */
  fields: TripFields;
}

/**
 * Score the trip again with `scorer` (the stored version's, from `requireScorer`) under `metrics`
 * over `events` (statuses as they should be; `disputed` settles to `removed`), re-derive the
 * severe flag over the same events, rebuild the aggregates around the result, and apply it all in
 * one writer call.
 */
async function rescore(
  run: Run,
  trip: StoredTrip,
  scorer: typeof scoreTrip,
  metrics: TripMetrics,
  events: StoredEvent[]
): Promise<Recomputed> {
  const settled = settleDisputed(events);
  const hadSevereEvent = severeAfter(events, trip.hadSevereEvent);
  const scored = scorer(metrics, settled.map(toScorableEvent));
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
    phoneEvents: settled.filter((e) => e.category === 'phone' && e.status === 'scored').length,
    hadSevereEvent,
  });
  const result = await run.db.applyRecompute({
    userId: run.userId,
    tripId: trip.id,
    scored: { ...scored, hadSevereEvent },
    events: eventRows(settled, scored),
    day: aggregates.day,
    baselines: aggregates.baselines,
  });
  return {
    result,
    days: aggregates.day,
    hadSevereEvent,
    fields: {
      categoryDeductions: scored.categoryDeductions,
      exposure: scored.exposure,
      dataQuality: scored.dataQuality,
      hadSevereEvent,
      // Untouched by a re-score: it is an observation of the drive, not a scoring output.
      limitCoveragePct: trip.limitCoveragePct,
    },
  };
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
      hadSevereEvent: trip.hadSevereEvent,
      trip: storedFields(trip),
      days: await storedDays(run, trip),
      replayed: true,
    };
    return json(200, replay);
  }

  // a row this function cannot re-score from must fail before the writer consumes allowance
  const metrics = requireMetrics(trip, trip.role);
  const scorer = requireScorer(trip);

  if (!preview.can_auto_accept) {
    const denied = await db.countDeniedDisputes(userId, run.nowMs - DAY_MS);
    if (denied >= MAX_DENIED_PER_DAY) {
      return json(429, { code: 'too_many_disputes' }, { 'retry-after': String(RETRY_AFTER_DENIED_S) });
    }
  }

  const decision = await db.recordDispute(userId, event.id, a.reason, a.note ?? null, a.statedLimitMph ?? null);

  let score = trip.score;
  let status = trip.status;
  let hadSevereEvent = trip.hadSevereEvent;
  let fields = storedFields(trip);
  let days: DayRow[];
  // An accepted dispute leaves the event `disputed` until the recompute stores it as `removed`; a
  // replay whose event is already `removed` was finished the first time.
  if (decision.auto_accepted && decision.event_status !== 'removed') {
    // The writer has just put this event at `disputed`; saying so here as well costs nothing and
    // keeps the recompute right if the read raced the write. `rescore` settles it to `removed`
    // and re-derives the severe flag over the same events.
    const events = (await db.listTripEvents(userId, trip.id)).map((e) =>
      e.id === event.id ? { ...e, status: 'disputed' } : e
    );
    const done = await rescore(run, trip, scorer, metrics, events);
    score = done.result.score;
    status = done.result.status;
    hadSevereEvent = done.hadSevereEvent;
    fields = done.fields;
    days = done.days;
  } else {
    days = await storedDays(run, trip);
  }
  const response: DisputeResponse = {
    tripId: trip.id,
    score,
    status,
    autoAccepted: decision.auto_accepted,
    remainingAllowance: decision.remaining_allowance,
    reason: decision.denied_reason,
    hadSevereEvent,
    trip: fields,
    days,
    replayed: decision.replayed,
  };
  return json(200, response);
}

async function setRole(run: Run, a: SetRoleAction): Promise<Response> {
  const { db, userId } = run;
  const trip = await db.findTripRow(userId, a.clientTripId);
  if (!trip) return json(404, { code: 'not_found' });
  if (trip.deletedAt !== null) {
    const replay: SetRoleResponse = {
      tripId: trip.id,
      role: trip.role,
      score: trip.score,
      status: trip.status,
      trip: storedFields(trip),
      days: await storedDays(run, trip),
      replayed: true,
    };
    return json(200, replay);
  }
  const metrics = requireMetrics(trip, a.role);
  const scorer = requireScorer(trip);
  const set = await db.setTripRole(userId, trip.id, a.role);
  // The writer has already unscored a passenger/other trip; the recompute writes the same result
  // (the scorer's own `unscored` / `passenger`) and refreshes the day rows and baselines, so both
  // roles go through the one path. The role does not touch the severe flag, but this recompute
  // settles any `disputed` event it finds, so the flag is re-derived over what survives.
  const done = await rescore(run, trip, scorer, metrics, await db.listTripEvents(userId, trip.id));
  const response: SetRoleResponse = {
    tripId: trip.id,
    role: set.role,
    score: done.result.score,
    status: done.result.status,
    trip: done.fields,
    days: done.days,
    replayed: false,
  };
  return json(200, response);
}

async function deleteTrip(run: Run, a: DeleteAction): Promise<Response> {
  const { db, userId } = run;
  // Privacy first, and *before* the lookup decides anything: the key is derived from the JWT and
  // the client id alone, so it can be removed whether or not a row exists. A drive whose upload
  // was refused, or whose finalize the delete itself stopped, can still have left an object in
  // Storage — returning 404 before this ran left that object there for good.
  await db.removeTrace(traceKey(userId, a.clientTripId));
  const trip = await db.findTripRow(userId, a.clientTripId);
  if (!trip) return json(404, { code: 'not_found' });
  const deleted = await db.softDeleteTrip(userId, trip.id);
  // Refreshed on a replay too: the first attempt may have died between the delete and this.
  // D2: the deleted drive stays on its day, judged with and without it, so deleting never raises
  // the day; the long-term score and the baselines leave it out.
  const aggregates = await aggregatesAfter(db, userId, run.nowMs, trip, null, { keepTripOnDay: true });
  await db.applyRecompute({
    userId,
    tripId: trip.id,
    scored: null,
    events: null,
    day: aggregates.day,
    baselines: aggregates.baselines,
  });
  const response: DeleteResponse = { tripId: trip.id, deleted: true, days: aggregates.day, replayed: deleted.replayed };
  return json(200, response);
}

export async function handleTripAction(req: Request, deps: ActionsDeps): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const id = requestId();
  const reply = (res: Response) => withRequestId(res, id);

  const wrongMethod = requirePost(req);
  if (wrongMethod) return reply(wrongMethod);

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyJwt(token);
    } catch (err) {
      // Auth itself failed (transport, GoTrue down), which says nothing about the token: retry
      log.error('trip-actions token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = TripActionSchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const action = parsed.data;

  const ctx: Ctx = { requestId: id, action: action.action };
  if (action.action === 'dispute') ctx.clientEventId = action.clientEventId;
  else ctx.clientTripId = action.clientTripId;
  const run: Run = { db: deps.db, log, nowMs: now(), userId, ctx };

  try {
    switch (action.action) {
      case 'dispute':
        return reply(await dispute(run, action));
      case 'set-role':
        return reply(await setRole(run, action));
      case 'delete':
        return reply(await deleteTrip(run, action));
    }
  } catch (err) {
    return reply(failure(err, log, ctx));
  }
}
