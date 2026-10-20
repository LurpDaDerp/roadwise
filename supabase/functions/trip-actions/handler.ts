// trip-actions: what a user may do to a stored drive (plan §4 "Edge functions", "Not driving",
// "Disputes"): `dispute { clientTripId, eventId, reason }` and `not_driving { clientTripId }`.
//
// The SQL owns every rule (latest drive only, 24 h, 2 a month, 7 days, 3 auto-accepts
// a week, 3 more a week for "DashPal got it wrong", the mounted test, "already disputed"); this
// function maps the request to one engine
// transaction, re-scores an accepted dispute with the shared scorer from the stored input and
// context (streak never re-evaluated), and turns the writers' fixed refusals into codes the device
// can show. Each action is one request from the device's queue, retried when its answer was lost:
// the writers answer a repeat with what the first one did (0016), never applying it twice, and
// refuse a dispute of an already disputed event for another reason (`already_disputed`).
import type { ApplyDisputeEnvelope, Engine } from '../_shared/engine.ts';
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
import { scoreDrive, type DriveEvent } from '../_shared/scoring/index';
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
  'already marked as not driving': { status: 409, code: 'already_marked' },
  'already disputed': { status: 409, code: 'already_disputed' },
  'only your latest drive can be marked': { status: 403, code: 'not_latest' },
  'the drive is older than 24 hours': { status: 403, code: 'too_old' },
  'the drive is older than 7 days': { status: 403, code: 'too_old' },
  'no uses left this month': { status: 403, code: 'no_uses_left' },
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

  // One transaction; a 40001 (another dispute landed between context and apply, so the re-score
  // was over a different set of events) is retried once from the context.
  const attempt = () =>
    deps.engine.transaction(async (tx) => {
      if (!(await tx.takeRateLimit(userId, ACTION_LIMIT_KEY, '1 hour', MAX_ACTIONS_PER_HOUR))) return { kind: 'limited' as const };

      if (a.action === 'not_driving' || a.reason === 'not_driving') {
        const r = NotDrivingResultSchema.safeParse(await tx.revertNotDriving(userId, a.clientTripId));
        if (!r.success) throw new EngineContractError('private.revert_latest_not_driving');
        return { kind: 'not_driving' as const, body: { action: 'not_driving', ...r.data } };
      }

      const d = await tx.disputeContext(userId, a.clientTripId, a.eventId, a.reason);
      const envelope: ApplyDisputeEnvelope = {
        user: userId,
        tripId: d.tripId,
        eventId: a.eventId,
        reason: a.reason,
        status: d.status,
        rejectReason: d.rejectReason,
      };
      if (d.status === 'accepted' && d.rescore) {
        // The stored input with the event already marked removed, under the drive's own context.
        const bd = scoreDrive(
          {
            miles: d.rescore.input.miles,
            safeMiles: d.rescore.input.safeMiles,
            loopRepeat: d.rescore.input.loopRepeat,
            // a DashPal drive keeps its ×1.25, so an accepted dispute never lowers the net
            dashcam: d.rescore.input.dashcam,
            events: d.rescore.input.events as DriveEvent[],
          },
          d.rescore.ctx
        );
        envelope.breakdown = bd;
        envelope.net = bd.net;
      }
      const r = DisputeResultSchema.safeParse(await tx.applyDispute(envelope));
      if (!r.success) throw new EngineContractError('private.apply_dispute');
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
