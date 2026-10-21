// trip-actions: what a user may do to a stored drive: `dispute { clientTripId, eventId, reason }`
// (report one event) and `not_driving { clientTripId }` ("Wasn't driving").
//
// The SQL owns every rule ("Wasn't driving": any drive, until 24 h after its end, only while its
// "Not driving?" never ran out, 2 a month; a report: within 7 days, a reason that fits the event,
// 3 auto-accepts a week, 3 more a week for "DashPal got it wrong", "already disputed"); each action
// is ONE SQL call in one transaction (`mark_not_driving`, `dispute_event`), and this function turns
// the writers' fixed refusals into codes the device can show. Each action is one request from the
// device's queue, retried when its answer was lost: the writers answer a repeat with what the first
// one did, never applying it twice, and refuse a report of an already reported event for another
// reason (`already_disputed`).
import type { Engine } from '../_shared/engine.ts';
import { EngineContractError } from '../_shared/engine.ts';
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
import { DisputeResultSchema, NotDrivingResultSchema, TripActionSchema } from './schema.ts';

/** An action body is a few ids; anything larger is not one. */
export const MAX_BODY_BYTES = 4096;
/** Actions a user may take per hour; above it the queue is told to wait. */
export const MAX_ACTIONS_PER_HOUR = 60;
export const ACTION_LIMIT_KEY = 'trip_actions';

export interface ActionsDeps {
  verifyJwt(token: string): Promise<string | null>;
  engine: Engine;
  log?: Logger;
}

/** The writers' fixed refusals → the device's codes (the message itself is our contract, not a leak). */
export const REFUSALS: Record<string, { status: number; code: string }> = {
  'trip not found': { status: 404, code: 'not_found' },
  'event not found': { status: 404, code: 'not_found' },
  'already disputed': { status: 409, code: 'already_disputed' },
  'the drive is older than 24 hours': { status: 403, code: 'too_old' },
  'the drive is older than 7 days': { status: 403, code: 'too_old' },
  'no uses left this month': { status: 403, code: 'no_uses_left' },
  'the not driving option expired': { status: 403, code: 'not_driving_expired' },
  'that reason does not apply to this event': { status: 400, code: 'reason_mismatch' },
};

export async function handleTripAction(req: Request, deps: ActionsDeps): Promise<Response> {
  const log = deps.log ?? console;
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
      log.error('trip-actions token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = TripActionSchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const a = parsed.data;
  const ctx = { requestId: id, action: a.action, clientTripId: a.clientTripId };

  // One transaction, one writer call; a 40001 (two actions on the same drive raced) is retried once.
  const attempt = () =>
    deps.engine.transaction(async (tx) => {
      if (!(await tx.takeRateLimit(userId, ACTION_LIMIT_KEY, '1 hour', MAX_ACTIONS_PER_HOUR))) return { kind: 'limited' as const };

      if (a.action === 'not_driving' || a.reason === 'not_driving') {
        const r = NotDrivingResultSchema.safeParse(await tx.markNotDriving(userId, a.clientTripId));
        if (!r.success) throw new EngineContractError('private.mark_not_driving');
        return { kind: 'not_driving' as const, body: { action: 'not_driving', ...r.data } };
      }

      const r = DisputeResultSchema.safeParse(await tx.disputeEvent(userId, a.clientTripId, a.eventId, a.reason));
      if (!r.success) throw new EngineContractError('private.dispute_event');
      return { kind: 'dispute' as const, body: { action: 'dispute', clientTripId: a.clientTripId, ...r.data } };
    });
  try {
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt();
    } catch (err) {
      if (!(isPgError(err) && err.code === '40001')) throw err;
      log.warn('trip-actions retried once after a serialization failure', ctx);
      result = await attempt();
    }
    if (result.kind === 'limited') return reply(json(429, { code: 'too_many_requests' }, { 'retry-after': '600' }));
    return reply(json(200, result.body));
  } catch (err) {
    if (err instanceof EngineContractError) {
      log.error('trip-actions engine contract', { ...ctx, message: err.message });
      return reply(json(500, { code: 'internal' }));
    }
    if (isPgError(err)) {
      const known = REFUSALS[err.message];
      if (known && (err.code === '42501' || err.code === 'P0002' || err.code === '22023')) {
        return reply(json(known.status, { code: known.code }));
      }
    }
    return reply(pgFailure(err, log, ctx, 'trip-actions'));
  }
}
