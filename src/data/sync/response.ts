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

/**
 * The 400 body the functions answer with: `{ code, field? }`.
 *
 * The code is bounded because it does not stay in memory: it is written to `trips.sync_error` and
 * to a dispute record, and `sync_error` is rendered on D1. A server-controlled string with no
 * ceiling has no business in either.
 */
const MAX_CODE = 64;
const ErrorBodySchema = z.object({
  code: z.string().min(1).max(MAX_CODE),
  field: z.string().max(MAX_CODE).optional(),
});

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
  // storage-js puts the HTTP status in `status` and the body's own code in `statusCode`, and some
  // storage-api versions answer a duplicate as HTTP 400 with `statusCode: '409'` — so the body's
  // code and error name are checked too, not only the transport status.
  const alreadyExists =
    status === 409 ||
    asStatus(record.statusCode) === 409 ||
    record.error === 'Duplicate' ||
    record.code === 'Duplicate' ||
    record.code === 'KeyAlreadyExists' ||
    /already exists/i.test(message);
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

/** A local calendar date, which is both the day row's identity and its cache key. */
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One day's standing, as `finalize-trip` recomputed it over every trip the server holds for that
 * date (§9.9). Cached verbatim under `day`, so the home screen has the badges with no network.
 *
 * Strict, like the upload contract it answers: a key this build does not know is drift between the
 * device and the function, and a response the device cannot read is better retried — and reported —
 * than half-applied. `z.number()` in zod 4 already refuses NaN and Infinity, so every number here is
 * finite (pinned by a test).
 */
export const DayRowSchema = z
  .object({
    day: z.string().regex(LOCAL_DAY),
    /** The §9.6 long-term score as of this day, or null before there is enough driving for one. */
    longTermScore: z.number().int().min(0).max(100).nullable(),
    band: z.string().min(1).max(32).nullable(),
    /** The day is still provisional: more trips for it may yet arrive. */
    provisional: z.boolean(),
    safeDay: z.boolean(),
    goodDay: z.boolean(),
    phoneFreeDay: z.boolean(),
    cameraDay: z.boolean(),
    exposure: z.number().nonnegative(),
    drivingS: z.number().nonnegative(),
    tripsScored: z.number().int().nonnegative(),
    /**
     * The day's final drives including deleted ones (0009, D2): 0 is a day with no counted drive;
     * above 0 with `tripsScored` 0 is a day whose only drives were deleted. Absent from an older
     * server, where a reader falls back to `tripsScored`.
     */
    tripsAll: z.number().int().nonnegative().optional(),
    severeEvents: z.number().int().nonnegative(),
  })
  .strict();

export type DayRow = z.infer<typeof DayRowSchema>;

/** The six scoring categories, as the breakdown is keyed. */
const CATEGORY_KEYS = ['phone', 'speeding', 'braking', 'accel', 'cornering', 'focus'] as const;

/**
 * What the server stored on the trip beyond its score, and what the device row must follow.
 *
 * The server is the authority: it re-scores from the payload on every finalize, dispute, role
 * change and delete-refresh, and writes a fresh breakdown, exposure and grade. Nothing on the
 * device ever re-reads a trip, so a field that does not travel here is the device's own
 * finalizer's guess for the life of the install — which is how D2's category bars came to
 * contradict the score printed above them after an accepted dispute, and how a crash-recovered
 * drive kept showing an A the server had graded B.
 *
 * Strict and fully required, like the day row beside it: a partial answer is not applied.
 */
export const TripFieldsSchema = z
  .object({
    categoryDeductions: z.object(
      Object.fromEntries(CATEGORY_KEYS.map((key) => [key, z.number().min(0).max(100)]))
    ),
    exposure: z.number().positive(),
    dataQuality: z.enum(['A', 'B', 'C']),
    hadSevereEvent: z.boolean(),
    limitCoveragePct: z.number().min(0).max(100).nullable(),
  })
  .strict();

export type TripFields = z.infer<typeof TripFieldsSchema>;

/**
 * What `finalize-trip` answers with on success — exactly six keys, all required.
 *
 * Strict by ruling: the runner writes the trip row and the day cache from this and nothing else, so
 * a response it cannot read in full must not be applied at all. A parse failure is *retryable*, not
 * terminal (`runner.ts`): the payload was fine and the server accepted it, so the fix is a new build
 * or a server correction, never dropping the trip.
 */
export const FinalizeResponseSchema = z
  .object({
    tripId: z.uuid(),
    /** Null exactly when the trip carries no score. */
    score: z.number().int().min(0).max(100).nullable(),
    status: z.enum(SERVER_TRIP_STATUSES),
    day: DayRowSchema,
    /** What the server stored on the trip beyond the score; the device row follows it. */
    trip: TripFieldsSchema,
    /** The server's re-score disagreed with the device's provisional one by more than 2 points. */
    provisionalMismatch: z.boolean(),
    /** True when the server had already applied this trip — a retry that converged. */
    replayed: z.boolean(),
  })
  .strict()
  .refine((r) => (r.score !== null) === (r.status === 'provisional' || r.status === 'final'), {
    error: 'a score exists exactly when the trip is scored',
    path: ['score'],
  });

export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;
