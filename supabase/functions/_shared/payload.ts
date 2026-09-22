// The `finalize-trip` upload contract (design §4.4).
//
// This file is the contract's single source: the device validates what it queues against it and
// the edge function validates what it receives against a byte-identical copy (`_shared/payload.ts`,
// synced by `scripts/sync-scoring.js` in M2). So it must stay self-contained: zod only — no `@/`
// alias, no `@scoring`, no React Native, no Node built-ins. The event and result shapes below
// mirror `ScorableEvent` and `ScoredTrip` in `packages/scoring/src/types.ts` field for field;
// `src/data/sync/__tests__/payload.test.ts` pins that they stay assignable both ways.
//
// Every object is `strict()`: a key the contract does not know is drift between the two ends,
// not data, and is better refused on the device than 400'd by the server after the samples are
// gone. The two size caps are the server's plausibility limits, enforced here for the same reason.
import { z } from 'zod';

/** The server refuses more events than this; the finalizer trims the upload to fit. */
export const MAX_EVENTS = 500;
/** The server refuses a longer polyline; the finalizer re-simplifies until it fits. */
export const MAX_POLYLINE_BYTES = 16_384;

/**
 * A time zone NAME (IANA: `America/New_York`, `Etc/GMT+5`, `UTC`), never a fixed offset such as
 * `+05:00` or `UTC+5`: V8 and Postgres read an offset's sign oppositely, so an offset would put the
 * server's local day, and the age-band rollover that follows it, a day away from the device's.
 * The first segment is letters only; 0006's `trips_tz_iana` CHECK holds the same rule in SQL.
 */
export const TZ_NAME_PATTERN = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/;

const EVENT_CATEGORIES = ['phone', 'speeding', 'braking', 'accel', 'cornering', 'focus'] as const;

const epochMs = z.number().int().nonnegative();
const nonNegative = z.number().nonnegative();
const unit = z.number().min(0).max(1);

/** Already rounded to 3 dp (§4.2 `lat/lng numeric(8,3)`), or absent. */
const roundedTo3dp = (v: number | null): boolean => v === null || Number(v.toFixed(3)) === v;

/** `ScorableEvent['measured']`: only the keys the scorer reads. */
export const MeasuredSchema = z
  .object({
    speedMps: nonNegative.optional(),
    limitMps: nonNegative.optional(),
    overMps: nonNegative.optional(),
    peakG: nonNegative.optional(),
    lateralG: nonNegative.optional(),
    glanceS: nonNegative.optional(),
    focusKind: z.enum(['glance', 'drowsiness']).optional(),
  })
  .strict();

export const ContextSchema = z.object({ night: z.boolean(), precipitation: z.boolean() }).strict();

/**
 * One event: a `ScorableEvent` (so the server can re-score it as the device did) plus the
 * server's `trip_events` columns that are derived from it — `durationMs`, `severity`,
 * `contextMultiplier`, `deduction`, the 3 dp coordinates, `alertShown` and `source`.
 */
export const PayloadEventSchema = z
  .object({
    id: z.string().min(1).max(64),
    category: z.enum(EVENT_CATEGORIES),
    startedAt: epochMs,
    durationS: nonNegative,
    durationMs: z.number().int().nonnegative(),
    q: unit,
    corrected: z.boolean(),
    status: z.enum(['scored', 'possible', 'disputed', 'removed']),
    measured: MeasuredSchema,
    context: ContextSchema,
    /** `contextMultiplier(e)` from the scoring package: 1 up to `CONTEXT_CAP`. */
    contextMultiplier: z.number().min(1).max(1.5),
    /** `severity(e)` from the scoring package: the §9.3 band value. */
    severity: nonNegative,
    /** Points this event cost before the category cap; null on a trip that was not scored. */
    deduction: nonNegative.nullable(),
    /** Rounded to 3 dp; null inside the trimmed ends of the trip or without a fix. */
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    alertShown: z.boolean(),
    source: z.enum(['gnss', 'imu', 'both', 'os', 'camera']),
  })
  .strict()
  .refine((e) => e.durationMs === Math.round(e.durationS * 1000), {
    error: 'durationMs must be durationS in milliseconds',
    path: ['durationMs'],
  })
  .refine((e) => roundedTo3dp(e.lat) && roundedTo3dp(e.lng), {
    error: 'coordinates must already be rounded to 3 decimal places',
    path: ['lat'],
  });

/** `ScoredTrip` from the scoring package, as the device computed it. */
export const ScoredTripSchema = z
  .object({
    score: z.number().int().min(0).max(100).nullable(),
    status: z.enum(['final', 'unscored', 'discarded']),
    reason: z.enum(['passenger', 'role_unknown', 'too_short', 'grade_c', 'implausible_speed']).optional(),
    exposure: z.number().positive(),
    dataQuality: z.enum(['A', 'B', 'C']),
    categoryDeductions: z
      .object({
        phone: nonNegative,
        speeding: nonNegative,
        braking: nonNegative,
        accel: nonNegative,
        cornering: nonNegative,
        focus: nonNegative,
      })
      .strict(),
    eventDeductions: z.record(z.string(), nonNegative),
    scoringVersion: z.literal(1),
  })
  .strict()
  .refine((t) => (t.score !== null) === (t.status === 'final'), {
    error: 'a score exists exactly when the trip is final',
    path: ['score'],
  });

/** What the trace holds, so the server can check the upload against the file. */
export const RowsDigestSchema = z
  .object({
    count: z.number().int().nonnegative(),
    validGnssPct: z.number().min(0).max(100),
    imuPresent: z.boolean(),
    maxSustainedSpeedMps: nonNegative,
    /** Lowercase hex SHA-256 of the canonical JSON the trace file holds. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const FinalizeTripPayloadSchema = z
  .object({
    clientTripId: z.string().min(1).max(64),
    startedAt: epochMs,
    endedAt: epochMs,
    /** IANA time zone the trip was recorded in: a name, never an offset (`TZ_NAME_PATTERN`). */
    tz: z.string().min(1).max(64).regex(TZ_NAME_PATTERN),
    distanceM: nonNegative,
    /**
     * Net of gap-merge gaps on a trip the engine closed. On a recovered trip (`incomplete`) the
     * gaps existed only in memory, so this is the wall span from the first row to the last
     * durable row plus one second — never more than `endedAt − startedAt`, but a drive that
     * gap-merged through a stop reports the stop as driving, and `rowsDigest.count` can fall
     * well below it.
     */
    durationS: nonNegative,
    /**
     * Who was driving as the device decided it. `unknown` is an auto-detected drive whose
     * evidence was ambiguous (§9.7): the scorer leaves it unscored as `role_unknown` until the
     * driver answers C10. `other` is only ever stated afterwards, through trip-actions.
     */
    role: z.enum(['driver', 'passenger', 'unknown']),
    roleConfidence: unit.nullable(),
    /** How the role was decided: `manual`, `auto`, or what a later milestone adds. */
    roleSource: z.string().min(1).max(32).nullable(),
    mode: z.enum(['mounted', 'pocket', 'auto']),
    cameraSession: z.boolean(),
    provisional: ScoredTripSchema,
    /** At most `MAX_EVENTS`; the finalizer drops removed, then possible, then the cheapest scored. */
    events: z.array(PayloadEventSchema).max(MAX_EVENTS),
    rowsDigest: RowsDigestSchema,
    startGeohash5: z.string().length(5).nullable(),
    endGeohash5: z.string().length(5).nullable(),
    /**
     * Share of the drive's rows that had a known posted limit, 0–100.
     *
     * It gates whether "kept to the limit" may be claimed at all (§9.3: speeding is not scored
     * where the limit is unknown), and both D1's highlight and E2's clean stamp read it. It has
     * to travel, or the rule exists on the device and nowhere else — the server's re-score path
     * and anything restored from the server would have no value to read.
     *
     * Nullable rather than optional: a build that predates the field queued its work into a
     * database that predates `sync_queue.owner_uid` too, and the runner refuses those items on
     * their own account (they cannot be attributed), so there is nothing left for a default to
     * rescue.
     */
    limitCoveragePct: z.number().min(0).max(100).nullable(),
    /**
     * Google encoded polyline, simplified, roughly 200 m trimmed at each end; '' when nothing is
     * left. Its characters are ASCII 63–126, so the length in code units is the length in bytes.
     */
    polyline: z.string().max(MAX_POLYLINE_BYTES),
    /**
     * Storage object name under the user's prefix: exactly `<clientTripId>.bin.gz`, or null when
     * no trace was written. The server derives the object key from the JWT and this id, never
     * from the field itself (§4.7: no client-supplied identifiers are trusted).
     */
    tracePath: z.string().min(1).max(256).nullable(),
    /** A scored speeding event at or beyond `SEVERE_SPEEDING_OVER_MPS`, or any L3 alert (§9.9 safe day). */
    hadSevereEvent: z.boolean(),
    /**
     * Finalized by crash recovery from the last checkpoint rather than by the engine that
     * recorded it (§19.1): the rows past that checkpoint may be missing, no alerts were
     * delivered, and `durationS` is the wall span (see there). False on every trip the engine
     * closed itself.
     */
    incomplete: z.boolean(),
  })
  .strict()
  .refine((p) => p.endedAt >= p.startedAt, { error: 'endedAt precedes startedAt', path: ['endedAt'] })
  .refine((p) => p.tracePath === null || p.tracePath === `${p.clientTripId}.bin.gz`, {
    error: 'tracePath must be null or <clientTripId>.bin.gz',
    path: ['tracePath'],
  });

export type PayloadEvent = z.infer<typeof PayloadEventSchema>;
export type FinalizeTripPayload = z.infer<typeof FinalizeTripPayloadSchema>;
