// live-activity-start: shows a drive's Live Activity on the lock screen when the drive was noticed
// in the background (iOS 17.2 and later, ActivityKit push-to-start).
//
// The phone calls this once per drive it adopted while RoadWise was not in front:
// `{ deviceId, clientTripId, startedAt, state }`. Order of work, cheapest refusal first: method,
// JWT, size (4 KB), JSON, the contract (strict), then: APNs configured at all (else
// `unconfigured`, before anything is claimed), then `claim_live_activity_start` AS THE USER (the
// publishable key with the caller's token: RLS and `auth.uid()` decide whose device it is; 30 an
// hour per account; one send per drive in 15 minutes), then one APNs request.
//
// The answer is `{ sent, reason? }` with reason `no_token` (this device registered no push-to-start
// token), `duplicate` (already sent for this drive), `apns_error` (Apple refused or did not
// answer) or `unconfigured`. A missing token or a refused push is never a 5xx: the phone's own
// "Recording your drive" notification and its local start on the next foreground cover it.
//
// Logs carry the request id and codes only: never the device token, a secret, a position or a name.
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ApnsClient } from '../_shared/apns.ts';
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
  })
  .strict();
export type LiveActivityStart = z.infer<typeof LiveActivityStartSchema>;

export const LiveActivityStartResultSchema = z.object({
  sent: z.boolean(),
  reason: z.enum(['no_token', 'duplicate', 'apns_error', 'unconfigured']).optional(),
});
export type LiveActivityStartResult = z.infer<typeof LiveActivityStartResultSchema>;

/** What `claim_live_activity_start` answers. */
export const ClaimSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32,200}$/).nullable(),
  duplicate: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Claims the caller's device token for one drive, as the caller (their token, never the secret key). */
export type ClaimFn = (userToken: string, deviceId: string, clientTripId: string) => Promise<unknown>;

export interface LiveActivityDeps {
  verifyJwt(token: string): Promise<string | null>;
  claim: ClaimFn;
  /** null when the APNs secrets are not set. */
  apns: ApnsClient | null;
  log?: Logger;
  /** epoch ms */
  now?: () => number;
}

/** The claim over the Data API as the user: PostgREST runs it as `authenticated` with the caller's `auth.uid()`. */
export function createClaim(url: string, publishableKey: string): ClaimFn {
  return async (userToken, deviceId, clientTripId) => {
    const client = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });
    const { data, error } = await client.rpc('claim_live_activity_start', { p_device_id: deviceId, p_client_trip_id: clientTripId });
    if (error) throw asPgError(error);
    return data;
  };
}

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
  const ctx = { requestId: id, clientTripId: a.clientTripId };

  // nothing is claimed while there is no way to send: a later deploy of the secrets can still start it
  if (!deps.apns) return reply(answer({ sent: false, reason: 'unconfigured' }));

  let claim: Claim;
  try {
    const raw = await deps.claim(token, a.deviceId, a.clientTripId);
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
  const result = await deps.apns.sendLiveActivityStart(claim.token, {
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
  if (!result.ok) {
    log.warn('live-activity-start apns refused', { ...ctx, status: result.status, reason: result.reason, host: result.host });
    return reply(answer({ sent: false, reason: 'apns_error' }));
  }
  return reply(answer({ sent: true }));
}
