/**
 * Asking the server to start the drive's Live Activity by push (`live-activity-start`, iOS 17.2+):
 * the drive host calls it once per drive and leg when a drive begins, or is re-opened after a stop,
 * with RoadWise not in front, so the lock screen shows it. The server sends the ActivityKit
 * push-to-start to the token this install registered (`register_device`), at most once per drive
 * and leg; a send Apple refused or never answered hands its claim back, so a retry can send.
 *
 * The request's `state` is the activity's first content state: its `speed` and `limit` (in `unit`,
 * null for "-") are what the activity shows the moment it appears, so the host fills them before it
 * asks (the server forwards them as they are; the weather line never goes).
 *
 * Nothing here throws and nothing waits long: no token, no network, a server without the function
 * or any other failure is an outcome with its reason (`requestLiveActivityStartOutcome`), and the
 * drive's own "Recording your drive" notification stands in. `createLiveActivityStarter` is the
 * retry-safe way to ask: one request per drive and leg at a time, and none again once one was sent.
 * Nothing about the drive is stored here.
 */
import type { LiveDriveState } from '@live-drive';

export const LIVE_ACTIVITY_START_FUNCTION = 'live-activity-start';
/** The longest the host waits for an answer; a later one is not waited for. */
export const LIVE_ACTIVITY_START_TIMEOUT_MS = 10_000;

export interface LiveActivityStartRequest {
  /** This install's id (`getInstallId`): the device row whose token the push goes to. */
  deviceId: string;
  clientTripId: string;
  /** The drive's leg: 0 for the first, then one more each time the drive is re-opened (an integer). */
  leg: number;
  /** The drive's start, epoch ms (the activity's `startedAt`). */
  startedAt: number;
  /** The first lock-screen state, its speed and limit included (weather none: the push never carries it). */
  state: LiveDriveState;
}

/**
 * Why no push went:
 * - the server's answers: `no_token` (this install registered no push-to-start token), `duplicate`
 *   (already sent for this drive and leg, or a later leg, in the last 15 minutes), `apns_error`
 *   (Apple refused or did not answer; `detail` holds Apple's code), `unconfigured` (the server has
 *   no APNs secrets);
 * - the server refused the call: `rate_limited` (30 an hour), `unauthorized` (the session token was
 *   refused), `invalid` (the request is outside the contract: a bug), `not_deployed` (no such
 *   function), `server_error` (a 5xx, or the relay failed);
 * - no usable answer: `timeout` (none within the timeout), `network` (the call never got through),
 *   `bad_answer` (a 2xx outside the contract).
 */
export type LiveActivityStartReason =
  | 'no_token'
  | 'duplicate'
  | 'apns_error'
  | 'unconfigured'
  | 'rate_limited'
  | 'unauthorized'
  | 'invalid'
  | 'not_deployed'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'bad_answer';

export interface LiveActivityStartOutcome {
  /** The server sent the push-to-start (the activity should appear within seconds). */
  sent: boolean;
  /** Why not; null exactly when `sent`. */
  reason: LiveActivityStartReason | null;
  /** `apns_error` only: Apple's reason code (`BadDeviceToken`, ...) or `timeout` / `network` / `bad_key`; else null. */
  detail: string | null;
  /**
   * Asking again soon (for the same drive and leg) may send: `timeout`, `network`, `server_error`,
   * `unauthorized` (the session refreshes itself), and `apns_error` when the server handed its claim
   * back after a passing failure. False when sent and for every other reason.
   */
  retryable: boolean;
}

export interface LiveActivityStartDeps {
  /** `supabase.functions.invoke`; the app's own client when absent. */
  invoke?: (name: string, options: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;
  timeoutMs?: number;
  onError?: (error: unknown, context: string) => void;
}

/** The reasons the server answers with a 200. */
const SERVER_REASONS: ReadonlySet<string> = new Set(['no_token', 'duplicate', 'apns_error', 'unconfigured']);
const DETAIL = /^[A-Za-z_]{1,64}$/;
const RETRYABLE: ReadonlySet<LiveActivityStartReason> = new Set(['timeout', 'network', 'server_error', 'unauthorized']);

const sentOutcome = (): LiveActivityStartOutcome => ({ sent: true, reason: null, detail: null, retryable: false });
const failed = (reason: LiveActivityStartReason, detail: string | null = null, retryable = RETRYABLE.has(reason)): LiveActivityStartOutcome => ({
  sent: false,
  reason,
  detail,
  retryable,
});

function defaultInvoke(): NonNullable<LiveActivityStartDeps['invoke']> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when called for real
  const { supabase } = require('@/data/supabase/client') as typeof import('@/data/supabase/client');
  return (name, options) => supabase.functions.invoke(name, { body: options.body as Record<string, unknown> });
}

/** A 2xx answer: `{ sent, reason?, detail?, retry? }` (supabase/functions/live-activity-start/handler.ts). */
function fromAnswer(data: unknown): LiveActivityStartOutcome {
  if (typeof data !== 'object' || data === null) return failed('bad_answer');
  const a = data as { sent?: unknown; reason?: unknown; detail?: unknown; retry?: unknown };
  if (a.sent === true) return sentOutcome();
  if (a.sent !== false || typeof a.reason !== 'string' || !SERVER_REASONS.has(a.reason)) return failed('bad_answer');
  if (a.reason !== 'apns_error') return failed(a.reason as LiveActivityStartReason, null, false);
  // an older server sends neither: it kept its claim, so a retry would only be a duplicate
  const detail = typeof a.detail === 'string' && DETAIL.test(a.detail) ? a.detail : null;
  return failed('apns_error', detail, a.retry === true);
}

/** `functions.invoke`'s error: FunctionsHttpError (its `context` the Response), FunctionsFetchError, FunctionsRelayError. */
function fromError(error: unknown): LiveActivityStartOutcome {
  const e = typeof error === 'object' && error !== null ? (error as { name?: unknown; context?: unknown }) : null;
  if (e?.name === 'FunctionsFetchError') return failed('network');
  if (e?.name === 'FunctionsHttpError') {
    const status = typeof e.context === 'object' && e.context !== null ? (e.context as { status?: unknown }).status : undefined;
    if (status === 429) return failed('rate_limited');
    if (status === 401) return failed('unauthorized');
    if (status === 404) return failed('not_deployed');
    if (typeof status === 'number' && status >= 400 && status < 500) return failed('invalid');
  }
  return failed('server_error');
}

/** The outcome of one ask, with its reason. Never throws; gives up after the timeout. */
export async function requestLiveActivityStartOutcome(req: LiveActivityStartRequest, deps: LiveActivityStartDeps = {}): Promise<LiveActivityStartOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invoke = deps.invoke ?? defaultInvoke();
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.timeoutMs ?? LIVE_ACTIVITY_START_TIMEOUT_MS);
    });
    const body = { deviceId: req.deviceId, clientTripId: req.clientTripId, leg: req.leg, startedAt: req.startedAt, state: req.state };
    const reply = await Promise.race([invoke(LIVE_ACTIVITY_START_FUNCTION, { body }), timeout]);
    if (reply === null) return failed('timeout');
    if (reply.error) return fromError(reply.error);
    return fromAnswer(reply.data);
  } catch (error) {
    try {
      deps.onError?.(error instanceof Error ? new Error(error.name) : new Error('live activity start failed'), 'live activity start');
    } catch {
      // nobody left to tell
    }
    return failed('network');
  } finally {
    clearTimeout(timer);
  }
}

/** True when the server sent the push (`{ sent: true }`); false on anything else. Never throws. */
export async function requestLiveActivityStart(req: LiveActivityStartRequest, deps: LiveActivityStartDeps = {}): Promise<boolean> {
  return (await requestLiveActivityStartOutcome(req, deps)).sent;
}

/** How many sent drive legs a starter remembers (a drive has a few legs at most; older ones are long over). */
export const STARTER_MEMORY = 16;

export interface LiveActivityStarter {
  /**
   * Asks for the drive and leg in `req`, retry-safe: a call while one for the same install, drive
   * and leg is in flight gets that call's outcome (never two requests at once); once one was sent,
   * later calls answer `sent` again without asking (never a second push for a leg); after a failure
   * a call asks again (the retry; the outcome's `retryable` says whether one is worth it soon).
   * Never throws.
   */
  start(req: LiveActivityStartRequest): Promise<LiveActivityStartOutcome>;
}

export function createLiveActivityStarter(deps: LiveActivityStartDeps = {}): LiveActivityStarter {
  const inFlight = new Map<string, Promise<LiveActivityStartOutcome>>();
  const sent = new Set<string>();
  return {
    start(req) {
      const key = `${req.deviceId}|${req.clientTripId}|${req.leg}`;
      if (sent.has(key)) return Promise.resolve(sentOutcome());
      const running = inFlight.get(key);
      if (running) return running;
      const ask = requestLiveActivityStartOutcome(req, deps)
        .catch(() => failed('network'))
        .then((outcome) => {
          inFlight.delete(key);
          if (outcome.sent) {
            sent.add(key);
            if (sent.size > STARTER_MEMORY) sent.delete(sent.values().next().value as string);
          }
          return outcome;
        });
      inFlight.set(key, ask);
      return ask;
    },
  };
}
