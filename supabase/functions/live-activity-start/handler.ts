// live-activity-start: shows a drive's Live Activity on the lock screen when the drive was noticed
// in the background (iOS 17.2 and later, ActivityKit push-to-start).
//
// The phone calls this once per drive it adopted while RoadWise was not in front:
// `{ deviceId, clientTripId, startedAt, state, leg? }`, `leg` 0 from this app (0 to 50, 0 when left
// out; an older build sent 1, 2, … for a drive it re-opened after a stop, each leg its own claim). Order of work, cheapest refusal
// first: method, JWT, size (4 KB), JSON, the contract (strict), then: APNs configured at all (else
// `unconfigured`, before anything is claimed), then `claim_live_activity_start` AS THE USER (the
// publishable key with the caller's token: RLS and `auth.uid()` decide whose device it is; 30 an
// hour per account; one send per drive and leg in 15 minutes), then one APNs request. A send that
// Apple refused or that never reached Apple hands its claim back (`release_live_activity_start`,
// 0027, as the user again), so the phone's retry for the same drive and leg is a fresh claim.
//
// `state` is the activity's first content state as the phone holds it: its `speed` and `limit` (in
// `unit`, null for "-") go into the push's content state as they are, so the activity appears with
// the drive's speed and limit; the weather line never goes (the driving screen sets it).
//
// The answer is `{ sent, reason?, detail?, retry? }` with reason `no_token` (this device registered
// no push-to-start token), `duplicate` (already sent for this leg of the drive, or a later one),
// `apns_error` (Apple refused or did not answer) or `unconfigured`. With `apns_error`, `detail` is
// Apple's reason code (`BadDeviceToken`, `TopicDisallowed`, ...) or `timeout` / `network` /
// `bad_key` (null when Apple gave none), and `retry` says whether trying again soon can help: the
// claim was handed back and the failure was a passing one (no answer, Apple's 429 or 5xx). A missing
// token or a refused push is never a 5xx: the phone's own "Recording your drive" notification and
// its local start on the next foreground cover it.
//
// Logs carry the request id and codes only: never the device token, a secret, a position or a name.
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ApnsClient, ApnsResult } from '../_shared/apns.ts';
import { bearerToken, invalidPayload, json, pgFailure, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import { asPgError, isPgError } from '../_shared/pg.ts';

/** A start request is a few ids and a small state; anything larger is not one. */
export const MAX_BODY_BYTES = 4096;
/** A start for a drive that began longer ago than a drive can last is no use. */
const MAX_AGE_MS = 12 * 3_600_000;
/** Clock skew allowed for a start "in the future". */
const MAX_AHEAD_MS = 10 * 60_000;

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** The Live Activity's state as the phone holds it (`LiveDriveState`, modules/live-drive). */
export const LiveDriveStateSchema = z
  .object({
    speed: z.number().min(0).max(300).nullable(),
    limit: z.number().min(0).max(200).nullable(),
    unit: z.enum(['mph', 'km/h']),
    speedTint: Color.nullable(),
    speeding: z.boolean(),
    notDrivingAvailable: z.boolean(),
    weatherKind: z.string().regex(/^[a-z_]{1,32}$/).nullable(),
    weatherText: z.string().max(64).nullable(),
    skyTop: Color.nullable().optional(),
    skyMid: Color.nullable().optional(),
    skyLow: Color.nullable().optional(),
    accent: Color.nullable().optional(),
  })
  .strict();

export const LiveActivityStartSchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    clientTripId: z.uuid(),
    /** The drive's start, epoch ms (the activity's `startedAt` attribute). */
    startedAt: z.number().int().positive(),
    state: LiveDriveStateSchema,
    /** The drive's leg: each leg may start its activity once. This app sends 0 (one start per drive). */
    leg: z.number().int().min(0).max(50).default(0),
  })
  .strict();
export type LiveActivityStart = z.infer<typeof LiveActivityStartSchema>;

/** Apple's reason codes and ours (`timeout`, `network`, `bad_key`), as the answer may carry them. */
export const DETAIL = /^[A-Za-z_]{1,64}$/;

export const LiveActivityStartResultSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(['no_token', 'duplicate', 'apns_error', 'unconfigured']).optional(),
  /** `apns_error` only: Apple's reason code, or `timeout` / `network` / `bad_key`; null when none came. */
  detail: z.string().regex(DETAIL).nullable().optional(),
  /** `apns_error` only: the claim was handed back and the failure was a passing one, so a retry soon can send. */
  retry: z.boolean().optional(),
});
export type LiveActivityStartResult = z.infer<typeof LiveActivityStartResultSchema>;

/** What `claim_live_activity_start` answers. */
export const ClaimSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32,200}$/).nullable(),
  duplicate: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Claims the caller's device token for one leg of one drive, as the caller (their token, never the secret key). */
export type ClaimFn = (userToken: string, deviceId: string, clientTripId: string, leg: number) => Promise<unknown>;
/** Hands a failed send's claim back, as the caller: what `release_live_activity_start` answers (true when it did). */
export type ReleaseFn = (userToken: string, deviceId: string, clientTripId: string, leg: number) => Promise<unknown>;

export interface LiveActivityDeps {
  verifyJwt(token: string): Promise<string | null>;
  claim: ClaimFn;
  release: ReleaseFn;
  /** null when the APNs secrets are not set. */
  apns: ApnsClient | null;
  log?: Logger;
  /** epoch ms */
  now?: () => number;
}

/** The claim over the Data API as the user: PostgREST runs it as `authenticated` with the caller's `auth.uid()`. */
export function createClaim(url: string, publishableKey: string): ClaimFn {
  return async (userToken, deviceId, clientTripId, leg) => {
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });
    const { data, error } = await client.rpc('claim_live_activity_start', { p_device_id: deviceId, p_client_trip_id: clientTripId, p_leg: leg });
    if (error) throw asPgError(error);
    return data;
  };
}

/** The release over the Data API as the user, as `createClaim`. */
export function createRelease(url: string, publishableKey: string): ReleaseFn {
  return async (userToken, deviceId, clientTripId, leg) => {
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });
    const { data, error } = await client.rpc('release_live_activity_start', { p_device_id: deviceId, p_client_trip_id: clientTripId, p_leg: leg });
    if (error) throw asPgError(error);
    return data;
  };
}

/** A failure that may not happen again: no answer at all, Apple busy (429) or failing (5xx). */
export const passingFailure = (r: ApnsResult): boolean =>
  (r.status === 0 && (r.reason === 'timeout' || r.reason === 'network')) || r.status === 429 || r.status >= 500;

const answer = (body: LiveActivityStartResult): Response => json(200, body);

export async function handleLiveActivityStart(req: Request, deps: LiveActivityDeps): Promise<Response> {
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
      log.error('live-activity-start token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!token || !userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = LiveActivityStartSchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const a = parsed.data;
  const t = now();
  if (a.startedAt > t + MAX_AHEAD_MS || t - a.startedAt > MAX_AGE_MS) {
    return reply(json(400, { code: 'invalid_payload', issues: [{ path: 'startedAt', message: 'startedAt is not a drive in progress' }] }));
  }
  const ctx = { requestId: id, clientTripId: a.clientTripId, leg: a.leg };

  // nothing is claimed while there is no way to send: a later deploy of the secrets can still start it
  if (!deps.apns) return reply(answer({ sent: false, reason: 'unconfigured' }));

  let claim: Claim;
  try {
    const raw = await deps.claim(token, a.deviceId, a.clientTripId, a.leg);
    const c = ClaimSchema.safeParse(raw);
    if (!c.success) {
      log.error('live-activity-start claim outside the contract', ctx);
      return reply(json(500, { code: 'internal' }));
    }
    claim = c.data;
  } catch (err) {
    if (isPgError(err) && err.code === '42501' && err.message === 'too many requests') {
      return reply(json(429, { code: 'too_many_requests' }, { 'retry-after': '600' }));
    }
    // PostgREST refusing the token it was handed (expired between the two checks)
    if (isPgError(err) && /^PGRST30[0-9]$/.test(err.code)) return reply(json(401, { code: 'unauthorized' }));
    return reply(pgFailure(err, log, ctx, 'live-activity-start'));
  }
  if (claim.token === null) return reply(answer({ sent: false, reason: 'no_token' }));
  if (claim.duplicate) return reply(answer({ sent: false, reason: 'duplicate' }));

  const { weatherKind: _k, weatherText: _w, ...rest } = a.state;
  let result: ApnsResult;
  try {
    result = await deps.apns.sendLiveActivityStart(claim.token, {
      startedAt: a.startedAt,
      state: {
        ...rest,
        weatherKind: null,
        weatherText: null,
        skyTop: a.state.skyTop ?? null,
        skyMid: a.state.skyMid ?? null,
        skyLow: a.state.skyLow ?? null,
        accent: a.state.accent ?? null,
      },
    });
  } catch {
    // the client never throws; should it, nothing was sent
    result = { ok: false, status: 0, reason: 'network', host: 'production' };
  }
  if (!result.ok) {
    // the claim goes back so the phone's retry can send; a release that fails leaves it (the retry is then a duplicate)
    let released = false;
    try {
      released = (await deps.release(token, a.deviceId, a.clientTripId, a.leg)) === true;
    } catch (err) {
      log.warn('live-activity-start release failed', { ...ctx, code: isPgError(err) ? err.code : 'unknown' });
    }
    log.warn('live-activity-start apns refused', { ...ctx, status: result.status, reason: result.reason, host: result.host, released });
    const detail = result.reason !== null && DETAIL.test(result.reason) ? result.reason : null;
    return reply(answer({ sent: false, reason: 'apns_error', detail, retry: released && passingFailure(result) }));
  }
  return reply(answer({ sent: true }));
}
