import { z } from 'zod';

import type { TripStatus } from '@/data/db/types';

/**
 * Reading what Supabase hands back, and deciding what it means for a queued item.
 *
 * Three outcomes, and the whole retry policy hangs off them:
 * - `terminal` — the server understood the request and refused it. Retrying sends the identical
 *   bytes and gets the identical refusal, so the item is failed and the driver is told why.
 * - `unauthorized` — the access token had expired under the request. One refresh, one retry.
 * - `retryable` — nothing was decided (no network), or the server asked for later (429, 5xx).
 *
 * `functions.invoke` reports a non-2xx as a `FunctionsHttpError` whose `context` is the raw
 * `Response`, and a request that never left as a `FunctionsFetchError` with no context at all;
 * `storage.upload` reports a `StorageApiError` carrying a numeric `status`. Both are read
 * structurally here rather than by `instanceof`, so a test double is the real shape and not a
 * convenient one.
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
 * What an HTTP status means for a queued item. 408 and 425 join 429 and the 5xx range as "the
 * server did not decide"; every other 4xx is the server deciding against us. A 409 from
 * `finalize-trip` means the server wants the trace re-sent before it will decide, which is work
 * for a later pass, not a refusal.
 */
export function classifyStatus(status: number | null): FailureKind {
  if (status === null) return 'retryable';
  if (status === 401) return 'unauthorized';
  if (status === 408 || status === 409 || status === 425 || status === 429) return 'retryable';
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

/** The 400 body the functions answer with: `{ code, field? }`. */
const ErrorBodySchema = z.object({ code: z.string().min(1), field: z.string().optional() });

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
 * Classify a `functions.invoke` error. `now` dates a `Retry-After` given as an HTTP date.
 *
 * The code recorded is the server's own `code` when it sent one — that string reaches the driver
 * as the reason a trip will not upload — and otherwise names the status, so a support log can
 * still tell a 503 from a dropped connection.
 */
export async function classifyInvokeError(error: unknown, now: number): Promise<Failure> {
  const record = asRecord(error);
  const context = asRecord(record.context);
  const status = asStatus(context.status) ?? asStatus(record.status);
  const kind = classifyStatus(status);

  const headers = asRecord(context.headers);
  const getHeader = headers.get;
  const header =
    typeof getHeader === 'function'
      ? ((getHeader as (name: string) => string | null).call(headers, 'Retry-After') ?? null)
      : null;

  const body = await readBody(context);
  const parsed = ErrorBodySchema.safeParse(body);
  const code = parsed.success
    ? parsed.data.code
    : status === null
      ? 'network'
      : `http_${status}`;

  return { kind, code, status, retryAfterS: retryAfterSeconds(header, now) };
}

/**
 * Classify a `storage.upload` error. A 409 is not a failure at all: `upsert: false` refuses to
 * replace an object that is already there, which is exactly what a retry of an upload that did
 * reach Storage looks like, so it counts as uploaded.
 */
export function classifyStorageError(error: unknown): Failure & { alreadyExists: boolean } {
  const record = asRecord(error);
  const status = asStatus(record.status) ?? asStatus(record.statusCode);
  const message = typeof record.message === 'string' ? record.message : '';
  const alreadyExists = status === 409 || /already exists/i.test(message);
  return {
    alreadyExists,
    kind: classifyStatus(status),
    code: status === null ? 'network' : `storage_${status}`,
    status,
    retryAfterS: null,
  };
}

/** SQLite's one contention failure, which the driver deliberately does not retry (see `driver.ts`). */
export function isDatabaseLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

/** The statuses `finalize-trip` may settle a trip at — every local one but `recording`. */
const SERVER_TRIP_STATUSES = [
  'provisional',
  'final',
  'unscored',
  'discarded',
] as const satisfies readonly TripStatus[];

/**
 * What `finalize-trip` answers with on success.
 *
 * Unknown keys are dropped rather than refused: the response is read, never echoed, and a server
 * that starts reporting one more field must not fail every queued trip on an older build.
 * `score` is optional so that a response which omits it leaves the local score alone — a missing
 * key is not the same as `null`, which is the server saying "this trip has no score".
 */
export const FinalizeResponseSchema = z.object({
  tripId: z.string().min(1).max(64),
  score: z.number().nullable().optional(),
  status: z.enum(SERVER_TRIP_STATUSES),
  /** The day evaluation (§9.9) for the trip's local date, cached verbatim. */
  day: z.unknown().optional(),
  provisionalMismatch: z.boolean().optional(),
  /** True when the server had already applied this trip — a retry that converged. */
  replayed: z.boolean().optional(),
});

export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;

/**
 * The cache key for a day evaluation: the server's own `day` field when it carries one, else the
 * trip's local date, so the row is filed where the home screen will look for it either way.
 */
export function dayKeyOf(day: unknown, startedAt: number, tz: string): string {
  const named = asRecord(day).day;
  if (typeof named === 'string' && named.length > 0) return named;
  return localDay(startedAt, tz);
}

/** `YYYY-MM-DD` for an instant in a zone; the device's own date when Intl does not know it. */
export function localDay(ts: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
