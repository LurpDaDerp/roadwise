// finalize-trip: the server side of a drive upload.
//
// The phone detected the events, measured the miles and counted the drive's chances to slip; the
// server stores the drive and is authoritative for the week's goals, the achievements and the
// Safety Rating. Order of work, cheapest refusal first: method, JWT, size (512 KB, checked before
// parsing), JSON, the upload contract (v5; a v4 or v3 body from an older build is upgraded, so no drive
// is ever lost), the time zone and local day (derived here from tz + startedAt; an unknown IANA
// zone or a mislabelled day is refused), then ONE database transaction: `drive_context` (lock,
// idempotency) → the App Attest check → the daily upload budget → `drive_overlaps` → integrity → the
// DashPal speed gate re-applied → `classifyDrive`'s length rule → `apply_drive` → the response,
// stored for replays.
// Every upload is stored as its own drive: the envelope's `mergeInto` is always null, so the
// response's `mergedInto` is too. A drive that overlaps another stored drive of the user (by more
// than a minute) is stored unscored as implausible: one person drives one car at a time.
//
// Where a drive started and ended (the upload's `start` and `end`, which an older build still sends)
// goes no further than this function: neither is passed to the database, so no point outside the
// trimmed route is ever kept.
//
// App Attest (iPhone, attest.ts): an upload's assertion is checked against the user's attested key and
// the exact body bytes, and its counter stored, in the same transaction. With APP_ATTEST_ENFORCE on,
// an iPhone upload without a valid assertion is answered 429 `attest_required` (the phone attests and
// sends it again; a build from before App Attest retries a 429 and keeps the drive queued), one from a
// phone that says App Attest is not available is stored unscored as implausible, and an upload with
// no App Attest header from an account that has an Android device and never had an iPhone (no iOS
// device registered, no App Attest key) is scored as today. With it off,
// nothing is refused and the verdict only goes to the log. A replay is answered before the check.
//
// A user id comes from the JWT and nowhere else. Logs carry the request id, the client trip id and
// codes — never a position, a name or a database message.
import type { AttestSettings } from '../_shared/appattest.ts';
import type { ApplyDriveEnvelope, Engine, EnvelopeDashcam, EnvelopeEvent } from '../_shared/engine.ts';
import { EngineContractError } from '../_shared/engine.ts';
import { integrityReason } from '../_shared/finalize_rules.ts';
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
  FinalizeTripResponseSchema,
  MAX_PAYLOAD_BYTES,
  parseFinalizeUpload,
  type FinalizeTripPayloadV5,
  type FinalizeTripResponse,
  type PayloadEvent,
} from '../_shared/payload.ts';
import {
  clampExposure,
  classifyDrive,
  dashcamDrive,
  keepDashcamEvents,
  SCORING_VERSION,
  SPEEDING_MAX_OVER_MPH,
  speedingChargedS,
} from '../_shared/scoring/index';
import { checkUpload, NEEDS_ATTESTATION, readProof } from './attest.ts';

/** Uploads a user may make per rolling day; above it the queue is told to wait. */
export const MAX_UPLOADS_PER_DAY = 300;
export const UPLOAD_LIMIT_KEY = 'finalize_trip';
/** How long a build from before App Attest waits before it sends an upload refused `attest_required` again. */
export const ATTEST_RETRY_AFTER_S = 300;
/** apply_drive's fixed refusal of a zone pg_timezone_names lacks (0023). */
export const TZ_REFUSAL = 'payload needs clientTripId, a known tz, localDay and a valid reason';

export interface FinalizeDeps {
  /** The user id the token proves, or null when it proves nothing; throws when Auth is unreachable. */
  verifyJwt(token: string): Promise<string | null>;
  engine: Engine;
  /**
   * App Attest: the verifier's settings (null when APP_ATTEST_TEAM_ID is unset: nothing is verified)
   * and whether iPhone uploads must carry a valid assertion (APP_ATTEST_ENFORCE). Absent: off.
   */
  attest?: { settings: AttestSettings | null; enforce: boolean };
  log?: Logger;
}

/**
 * What an uploaded event measured, as stored and rated: a speeding event's `overMphS` (mph-seconds
 * over the line) is capped at `SPEEDING_MAX_OVER_MPH` per charged second, as the
 * rating reads it, so a bad reading is never kept. Every other key travels untouched.
 */
export function clampMeasured(e: PayloadEvent): PayloadEvent['measured'] {
  const m = e.measured;
  if (e.type !== 'speeding' || typeof m.overMphS !== 'number') return m;
  const cap = speedingChargedS(e.durationS) * SPEEDING_MAX_OVER_MPH;
  return m.overMphS > cap ? { ...m, overMphS: cap } : m;
}

/** An uploaded event, in the envelope's shape (always active). */
const fromPayload = (e: PayloadEvent): EnvelopeEvent => ({
  id: e.id,
  type: e.type,
  tier: e.tier,
  startedAt: e.startedAt,
  durationS: e.durationS,
  zone: e.zone ?? null,
  status: 'active',
  lat: e.lat,
  lng: e.lng,
  measured: clampMeasured(e),
});

/**
 * The DashPal seconds of what is stored: the upload's own (absent = none, `synced` absent = false),
 * with the DashPal-drive flag derived from them.
 */
export function dashcamOf(p: FinalizeTripPayloadV5): EnvelopeDashcam {
  const own = p.dashcam ?? null;
  const movingS = own?.movingS ?? 0;
  const coveredS = own?.coveredS ?? 0;
  const synced = own?.synced ?? false;
  const deviceId = own?.deviceId ?? null;
  return { deviceId, movingS, coveredS, synced, on: dashcamDrive({ movingS, coveredS, synced }) };
}

/**
 * What is stored: the upload alone. The DashPal speed gate is re-applied (scoring
 * `keepDashcamEvents`): an uploaded eyes-off or drowsy event under 10 mph or with no measured speed
 * is dropped, never stored, never rated; every other one counts. `short` is the length rule
 * (scoring `classifyDrive`: under 0.5 mi AND under 2 min) over what is stored.
 */
export function buildStoredDrive(p: FinalizeTripPayloadV5): { events: EnvelopeEvent[]; dashcam: EnvelopeDashcam; short: boolean } {
  const events = keepDashcamEvents(p.events).map(fromPayload);
  return { events, dashcam: dashcamOf(p), short: !classifyDrive({ miles: p.miles, durationS: p.durationS, events }).scored };
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
  // v5 as is; v4 upgraded with no phone seconds; v3 (an older build, or its queue) upgraded: its
  // screen-switch phone events go, origin manual
  const parsed = parseFinalizeUpload(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const p = parsed.data;
  const ctxLog = { requestId: id, clientTripId: p.clientTripId };
  const proof = readProof(req.headers);
  const enforce = deps.attest?.enforce === true;

  if (!isKnownTz(p.tz)) {
    return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'tz', message: 'unknown time zone' }] }));
  }
  const localDay = localDayOf(p.startedAt, p.tz);
  if (localDay !== p.localDay) {
    return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'localDay', message: 'localDay is not the date of startedAt in tz' }] }));
  }

  try {
    const result = await deps.engine.transaction(async (tx) => {
      const context = await tx.driveContext({ userId, clientTripId: p.clientTripId, startedAt: p.startedAt, endedAt: p.endedAt, localDay });
      if (context.existing) return { kind: 'replay' as const, response: context.existing };
      const attest = await checkUpload(tx, userId, proof, body.raw, deps.attest?.settings ?? null, enforce);
      if (enforce && NEEDS_ATTESTATION.has(attest.verdict)) {
        log.warn('finalize-trip attest required', { ...ctxLog, verdict: attest.verdict, reason: attest.reason ?? null });
        return { kind: 'attest_required' as const };
      }
      if (attest.verdict === 'invalid' || attest.verdict === 'unknown_key' || attest.verdict === 'unchecked') {
        log.warn('finalize-trip attest not verified', { ...ctxLog, verdict: attest.verdict, reason: attest.reason ?? null, enforce });
      }
      if (!(await tx.takeRateLimit(userId, UPLOAD_LIMIT_KEY, '1 day', MAX_UPLOADS_PER_DAY))) {
        return { kind: 'limited' as const };
      }
      const overlaps = await tx.driveOverlaps(userId, p.clientTripId, p.startedAt, p.endedAt);
      // Under enforcement, a phone without App Attest (a simulator) is stored but not scored.
      const unattested = enforce && attest.verdict === 'unsupported';

      // An integrity-refused drive, one overlapping another, or an unattested one is stored unscored.
      const refused = integrityReason(p) ?? (overlaps || unattested ? 'implausible' : null);
      const s = buildStoredDrive(p);
      const scored = !refused && !s.short;
      const reason: ApplyDriveEnvelope['reason'] = refused ?? (s.short ? 'too_short' : null);

      const envelope: ApplyDriveEnvelope = {
        user: userId,
        mergeInto: null,
        dashcam: s.dashcam,
        payload: {
          clientTripId: p.clientTripId,
          startedAt: p.startedAt,
          endedAt: p.endedAt,
          tz: p.tz,
          localDay,
          miles: p.miles,
          nightMiles: p.nightMiles,
          durationS: Math.round(p.durationS),
          end: null,
          polyline: p.polyline,
          appVersion: p.appVersion,
          dashcam: p.dashcam ?? null,
          origin: p.origin,
          notDrivingExpired: p.notDrivingExpired,
          exposure: p.exposure ? clampExposure(p.exposure) : null,
        },
        scored,
        reason,
        events: s.events,
        scoringVersion: SCORING_VERSION,
      };
      if (refused) log.warn('finalize-trip stored unscored', { ...ctxLog, reason: refused, overlaps, unattested });
      return { kind: 'applied' as const, response: await tx.applyDrive(envelope) };
    });

    if (result.kind === 'limited') return reply(json(429, { code: 'too_many_trips' }, { 'retry-after': '3600' }));
    if (result.kind === 'attest_required') {
      return reply(json(429, { code: 'attest_required' }, { 'retry-after': String(ATTEST_RETRY_AFTER_S) }));
    }
    // The stored document is our own contract; a document outside it says the database drifted.
    const response = FinalizeTripResponseSchema.safeParse(result.response);
    if (!response.success) {
      log.error('finalize-trip response outside the contract', { ...ctxLog, replay: result.kind === 'replay' });
      return reply(json(500, { code: 'internal' }));
    }
    const out: FinalizeTripResponse = response.data;
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
