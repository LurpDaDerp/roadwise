import { z } from 'zod';
export { DisputeResultSchema, NotDrivingResultSchema, type DisputeResult, type NotDrivingResult } from '@/data/sync/payload';

/**
 * Reading what Supabase hands back, and deciding what it means for a queued item.
 *
 * Three outcomes, and the whole retry policy hangs off them:
 * - `terminal` — the server understood the request and refused it. Retrying sends the identical
 *   bytes and gets the identical refusal, so the item is failed and the user is told why.
 * - `unauthorized` — the access token had expired under the request. One refresh, one retry.
 * - `retryable` — nothing was decided (no network), or the server asked for later (429, 5xx), or the
 *   server is older than the upload (`server_behind`: it refused the contract version itself).
 *
 * `functions.invoke` reports a non-2xx as a `FunctionsHttpError` whose `context` is the raw
 * `Response`, and a request that never left as a `FunctionsFetchError` with no context at all.
 * Both are read structurally rather than by `instanceof`.
 */

export type FailureKind = 'terminal' | 'unauthorized' | 'retryable';

export interface Failure {
  kind: FailureKind;
  /** Recorded on the item as `last_error`, and on the trip as `sync_error` when terminal. */
  code: string;
  status: number | null;
  /** Seconds the server asked us to wait, when it said so. */
  retryAfterS: number | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asStatus = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return null;
};

/**
 * What an HTTP status means for a queued item. 408, 425 and 429 join the 5xx range as "not
 * decided", and so does a bare 404: nothing read the payload, the function is simply not deployed
 * (yet, or any more), and the same bytes go through once it is (a function's own `not_found` is
 * told apart in `classifyInvokeError`). 409 is an answer: the server already holds the action
 * (`ALREADY_APPLIED` in the runner) or refuses it for good.
 */
export function classifyStatus(status: number | null): FailureKind {
  if (status === null) return 'retryable';
  if (status === 401) return 'unauthorized';
  if (status === 404 || status === 408 || status === 425 || status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  if (status >= 400) return 'terminal';
  return 'retryable';
}

/** `Retry-After` in seconds, from either form the header may take, or null. */
export function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 1000));
}

/** The 400 body the functions answer with: `{ code, field?, issues? }`. Bounded: it is stored and shown. */
const MAX_CODE = 64;
const ErrorBodySchema = z.object({ code: z.string().min(1).max(MAX_CODE), field: z.string().max(MAX_CODE).optional() });
/** Most issues looked at for the contract version; a longer list is not read further. */
const MAX_ISSUES = 50;

/** The code a refusal of the upload's contract version is retried under: the server is older than the app. */
export const SERVER_BEHIND_CODE = 'server_behind';

/**
 * Whether an `invalid_payload` refusal names the contract version (`path: 'v'`): an older server that
 * does not know this version yet. Such a refusal is not about the drive, and the same bytes go
 * through once the server is updated, so it is retried rather than failed.
 */
function refusesVersion(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return false;
  return issues.slice(0, MAX_ISSUES).some((issue) => typeof issue === 'object' && issue !== null && (issue as { path?: unknown }).path === 'v');
}

async function readBody(context: Record<string, unknown>): Promise<unknown> {
  const json = context.json;
  if (typeof json === 'function') {
    try {
      return await (json as () => Promise<unknown>).call(context);
    } catch {
      // A body that is not JSON tells us nothing the status has not already.
    }
  }
  return undefined;
}

/**
 * finalize-trip's 429 for an iPhone upload without an assertion it can check (App Attest enforced):
 * retryable like any 429; the runner attests a key and sends the drive again at once.
 */
export const ATTEST_REQUIRED_CODE = 'attest_required';

/** The code a function itself answers a 404 with (trip-actions: no such trip or event on the server). */
export const FUNCTION_NOT_FOUND_CODE = 'not_found';

/** Classify a `functions.invoke` error. `now` dates a `Retry-After` given as an HTTP date. */
export async function classifyInvokeError(error: unknown, now: number): Promise<Failure> {
  const record = asRecord(error);
  const context = asRecord(record.context);
  const status = asStatus(context.status) ?? asStatus(record.status);
  const kind = classifyStatus(status);

  const headers = asRecord(context.headers);
  const getHeader = headers.get;
  const header =
    typeof getHeader === 'function' ? ((getHeader as (name: string) => string | null).call(headers, 'Retry-After') ?? null) : null;

  const body = await readBody(context);
  const parsed = ErrorBodySchema.safeParse(body);
  const retryAfterS = retryAfterSeconds(header, now);

  // A 404 is two different answers. The function's own `not_found` (trip-actions: the trip or the
  // event is not on the server) is a refusal like any other: the same bytes get the same answer.
  // Anything else at a 404 is the gateway finding no function there, and the item records the
  // bare status, which is what the queue reopens on once a deploy answers it.
  if (status === 404) {
    if (parsed.success && parsed.data.code === FUNCTION_NOT_FOUND_CODE) return { kind: 'terminal', code: FUNCTION_NOT_FOUND_CODE, status, retryAfterS };
    return { kind, code: 'http_404', status, retryAfterS };
  }
  if (status === 400 && parsed.success && parsed.data.code === 'invalid_payload' && refusesVersion(body)) {
    return { kind: 'retryable', code: SERVER_BEHIND_CODE, status, retryAfterS };
  }
  const code = parsed.success ? parsed.data.code : status === null ? 'network' : `http_${status}`;

  return { kind, code, status, retryAfterS };
}

/**
 * The passenger RPCs' fixed refusals (`0034_passenger_rides.sql`) → the codes the device keeps on
 * the drive (`sync_error`), in the words of `trip-actions`' own where they mean the same.
 */
export const PASSENGER_REFUSALS: Readonly<Record<string, string>> = {
  'trip not found': FUNCTION_NOT_FOUND_CODE,
  'the not driving option expired': 'not_driving_expired',
  'the passenger mark came too late': 'passenger_too_late',
  'not an automatic drive': 'not_automatic',
  'invalid local day': 'invalid_local_day',
};

/**
 * Classify an error from a PostgREST RPC call (`supabase.rpc`), the way `classifyInvokeError`
 * reads a function's. An error with no code never reached the database (no network): retried, as
 * a transport failure. The writers' fixed refusals are terminal, under their codes; their
 * rate limit ("too many requests") waits 10 minutes. A function PostgREST does not know yet
 * (`PGRST202`: the migration is not on the server) is the missing-function case, reopened like a
 * 404. A JWT PostgREST refuses is `unauthorized`. Anything else, a timeout or a conflict among
 * them, was not decided: retried.
 */
export function classifyRpcError(error: unknown): Failure {
  const record = asRecord(error);
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (code === '') return { kind: 'retryable', code: 'network', status: null, retryAfterS: null };
  if (code === 'PGRST202') return { kind: 'retryable', code: 'http_404', status: 404, retryAfterS: null };
  if (code.startsWith('PGRST3')) return { kind: 'unauthorized', code: 'unauthorized', status: 401, retryAfterS: null };
  if (message === 'too many requests') return { kind: 'retryable', code: 'too_many_requests', status: 429, retryAfterS: 600 };
  const known = PASSENGER_REFUSALS[message];
  if (known !== undefined && (code === '42501' || code === 'P0002' || code === '22023')) {
    return { kind: 'terminal', code: known, status: code === 'P0002' ? 404 : 403, retryAfterS: null };
  }
  if (code === '42501' || code === '22023' || code === '22P02' || code === 'P0002' || code.startsWith('PGRST1')) {
    return { kind: 'terminal', code: `pg_${code}`.toLowerCase().slice(0, MAX_CODE), status: 400, retryAfterS: null };
  }
  return { kind: 'retryable', code: `pg_${code}`.toLowerCase().slice(0, MAX_CODE), status: 503, retryAfterS: null };
}

/** SQLite's one contention failure, which the driver deliberately does not retry (see `driver.ts`). */
export function isDatabaseLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}
