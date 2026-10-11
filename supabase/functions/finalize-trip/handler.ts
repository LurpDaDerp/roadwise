// finalize-trip: the server side of a drive upload (plan §3, §4 "Edge functions").
//
// The phone detected events and measured miles; the server is authoritative for points, streak,
// freezes, level, rating and leagues. Order of work, cheapest refusal first: method, JWT, size
// (512 KB, checked before parsing), JSON, the zod contract, the time zone and local day (derived
// here from tz + startedAt; an unknown IANA zone or a mislabelled day is refused), then ONE
// database transaction: `drive_context` (lock, lazy freeze grant, idempotency, streak state, the
// daily-cap and loop context, the merge target) → integrity → merge union → `scoreDrive` and
// `applyStreak` from the shared scoring package → `apply_drive` → the response, stored for replays.
//
// A user id comes from the JWT and nowhere else. Logs carry the request id, the client trip id and
// codes — never a position, a name or a database message.
import type { ApplyDriveEnvelope, Engine, EnvelopeDashcam, MergeTarget, StoredEvent } from '../_shared/engine.ts';
import { EngineContractError } from '../_shared/engine.ts';
import { integrityReason, isLoopDrive, isRefusedReason, unscoredBreakdown } from '../_shared/finalize_rules.ts';
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
import { isKnownTz, localDayOf } from '../_shared/local_day.ts';
import { isPgError } from '../_shared/pg.ts';
import {
  FinalizeTripPayloadV3Schema,
  FinalizeTripResponseV3Schema,
  MAX_PAYLOAD_BYTES,
  type FinalizeTripPayloadV3,
  type FinalizeTripResponseV3,
} from '../_shared/payload.ts';
import {
  applyStreak,
  dashcamDrive,
  scoreDrive,
  SCORING_VERSION,
  type DriveContext,
  type DriveEvent,
  type DriveInput,
  type StreakState,
} from '../_shared/scoring/index';

/** Uploads a user may make per rolling day; above it the queue is told to wait. */
export const MAX_UPLOADS_PER_DAY = 300;
export const UPLOAD_LIMIT_KEY = 'finalize_trip';
/** apply_drive's fixed refusal of a zone pg_timezone_names lacks (0008). */
export const TZ_REFUSAL = 'payload needs clientTripId, a known tz, localDay and a valid reason';

export interface FinalizeDeps {
  /** The user id the token proves, or null when it proves nothing; throws when Auth is unreachable. */
  verifyJwt(token: string): Promise<string | null>;
  engine: Engine;
  log?: Logger;
}

type EnvelopeEvent = ApplyDriveEnvelope['events'][number];

/** A stored event of the merge target, in the envelope's shape (its status survives). */
const fromStored = (e: StoredEvent): EnvelopeEvent => ({
  id: e.id,
  type: e.type,
  tier: e.tier,
  startedAt: e.startedAt,
  durationS: e.durationS,
  units: e.units ?? undefined,
  stoppedInTraffic: e.stoppedInTraffic ?? undefined,
  zone: e.zone,
  status: e.status,
  lat: e.lat,
  lng: e.lng,
  measured: e.measured,
});

/** An uploaded event, in the envelope's shape (always active). */
const fromPayload = (e: FinalizeTripPayloadV3['events'][number]): EnvelopeEvent => ({
  id: e.id,
  type: e.type,
  tier: e.tier,
  startedAt: e.startedAt,
  durationS: e.durationS,
  units: e.units,
  stoppedInTraffic: e.stoppedInTraffic,
  zone: e.zone ?? null,
  status: 'active',
  lat: e.lat,
  lng: e.lng,
  measured: e.measured,
});

/**
 * The DashPal seconds of what is scored. A fresh drive: the upload's own (absent = none). A merge:
 * the moving and covered seconds summed over the target and the upload, `synced` from the upload
 * (the newest part, absent = false), the device id the upload's else the target's — and the
 * DashPal-drive flag derived from those sums (never an OR of the two parts' flags).
 */
export function dashcamOf(p: FinalizeTripPayloadV3, merge: MergeTarget | null): EnvelopeDashcam {
  const own = p.dashcam ?? null;
  const movingS = (merge?.dashcam.movingS ?? 0) + (own?.movingS ?? 0);
  const coveredS = (merge?.dashcam.coveredS ?? 0) + (own?.coveredS ?? 0);
  const synced = own?.synced ?? false;
  const deviceId = own?.deviceId ?? merge?.dashcam.deviceId ?? null;
  return { deviceId, movingS, coveredS, synced, on: dashcamDrive({ movingS, coveredS, synced }) };
}

/** What is scored: the payload alone, or its union with the merge target (plan §4 "Merge"). */
export function buildScoringInput(
  p: FinalizeTripPayloadV3,
  merge: MergeTarget | null,
  loopDrivesToday: number,
  streakNow: StreakState,
  safeMilesEarlierToday: number
): {
  input: DriveInput;
  ctx: DriveContext;
  streak: StreakState;
  events: EnvelopeEvent[];
  isLoop: boolean;
  loopRepeat: boolean;
  dashcam: EnvelopeDashcam;
} {
  // a refused target never merges, even if a stale engine offered it
  if (merge && !isRefusedReason(merge.reason)) {
    const events = [...merge.events.map(fromStored), ...p.events.map(fromPayload)];
    const dashcam = dashcamOf(p, merge);
    return {
      input: {
        miles: merge.miles + p.miles,
        safeMiles: merge.safeMiles + p.safeMiles,
        events: events as DriveEvent[],
        loopRepeat: merge.loopRepeat,
        dashcam: dashcam.on,
      },
      ctx: { streak: merge.streak.streak, safeMilesEarlierToday: merge.safeMilesEarlierToday },
      streak: merge.streak,
      events,
      isLoop: merge.isLoop,
      loopRepeat: merge.loopRepeat,
      dashcam,
    };
  }
  const events = p.events.map(fromPayload);
  const isLoop = isLoopDrive(p.start, p.end, p.miles);
  const loopRepeat = isLoop && loopDrivesToday >= 2;
  const dashcam = dashcamOf(p, null);
  return {
    input: { miles: p.miles, safeMiles: p.safeMiles, events: events as DriveEvent[], loopRepeat, dashcam: dashcam.on },
    ctx: { streak: streakNow.streak, safeMilesEarlierToday },
    streak: streakNow,
    events,
    isLoop,
    loopRepeat,
    dashcam,
  };
}

export async function handleFinalizeTrip(req: Request, deps: FinalizeDeps): Promise<Response> {
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
      log.error('finalize-trip token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_PAYLOAD_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = FinalizeTripPayloadV3Schema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const p = parsed.data;
  const ctxLog = { requestId: id, clientTripId: p.clientTripId };

  if (!isKnownTz(p.tz)) {
    return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'tz', message: 'unknown time zone' }] }));
  }
  const localDay = localDayOf(p.startedAt, p.tz);
  if (localDay !== p.localDay) {
    return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'localDay', message: 'localDay is not the date of startedAt in tz' }] }));
  }

  try {
    const result = await deps.engine.transaction(async (tx) => {
      const context = await tx.driveContext({ userId, clientTripId: p.clientTripId, startedAt: p.startedAt, endedAt: p.endedAt, localDay, start: p.start });
      if (context.existing) return { kind: 'replay' as const, response: context.existing };
      if (!(await tx.takeRateLimit(userId, UPLOAD_LIMIT_KEY, '1 day', MAX_UPLOADS_PER_DAY))) {
        return { kind: 'limited' as const };
      }

      // An integrity-refused drive is stored alone and unscored: it never merges into a good one.
      const refused = integrityReason(p);
      const merge = refused || isRefusedReason(context.merge?.reason ?? null) ? null : context.merge;
      const s = buildScoringInput(p, merge, context.loopDrivesToday, context.streak, context.safeMilesEarlierToday);

      let breakdown = scoreDrive(s.input, s.ctx);
      let scored = breakdown.scored;
      let reason: ApplyDriveEnvelope['reason'] = breakdown.reason ?? null;
      if (refused) {
        breakdown = unscoredBreakdown(breakdown);
        scored = false;
        reason = refused;
      }
      const streak = applyStreak(s.streak, { scored, net: breakdown.net, activeEventCount: breakdown.activeEventCount });

      const envelope: ApplyDriveEnvelope = {
        user: userId,
        mergeInto: merge ? merge.tripId : null,
        dashcam: s.dashcam,
        payload: {
          clientTripId: p.clientTripId,
          startedAt: p.startedAt,
          endedAt: p.endedAt,
          tz: p.tz,
          localDay,
          miles: p.miles,
          safeMiles: p.safeMiles,
          nightMiles: p.nightMiles,
          durationS: Math.round(p.durationS),
          end: p.end,
          polyline: p.polyline,
          appVersion: p.appVersion,
          dashcam: p.dashcam ?? null,
        },
        scored,
        reason,
        net: breakdown.net,
        breakdown,
        events: s.events,
        streak: {
          before: { streak: s.streak.streak },
          after: streak.state,
          outcome: streak.outcome,
          freezeEarned: streak.freezeEarned,
        },
        isLoop: s.isLoop,
        loopRepeat: s.loopRepeat,
        safeMilesEarlierToday: s.ctx.safeMilesEarlierToday,
        scoringVersion: SCORING_VERSION,
      };
      if (refused) log.warn('finalize-trip stored unscored', { ...ctxLog, reason: refused });
      return { kind: 'applied' as const, response: await tx.applyDrive(envelope) };
    });

    if (result.kind === 'limited') return reply(json(429, { code: 'too_many_trips' }, { 'retry-after': '3600' }));
    // The stored document is our own contract; a document outside it says the database drifted.
    const response = FinalizeTripResponseV3Schema.safeParse(result.response);
    if (!response.success) {
      log.error('finalize-trip response outside the contract', { ...ctxLog, replay: result.kind === 'replay' });
      return reply(json(500, { code: 'internal' }));
    }
    const out: FinalizeTripResponseV3 = response.data;
    return reply(json(200, out, result.kind === 'replay' ? { 'x-replayed': 'true' } : {}));
  } catch (err) {
    if (err instanceof EngineContractError) {
      log.error('finalize-trip engine contract', { ...ctxLog, message: err.message });
      return reply(json(500, { code: 'internal' }));
    }
    // tzdata skew: a zone Intl knows and Postgres does not is the device's problem to fix, named
    if (isPgError(err) && err.code === '22023' && err.message === TZ_REFUSAL) {
      return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'tz', message: 'unknown time zone' }] }));
    }
    return reply(pgFailure(err, log, ctxLog, 'finalize-trip'));
  }
}
