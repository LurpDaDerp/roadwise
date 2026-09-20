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
    reason: z.enum(['passenger', 'too_short', 'grade_c', 'implausible_speed']).optional(),
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
    /** IANA time zone the trip was recorded in. */
    tz: z.string().min(1).max(64),
    distanceM: nonNegative,
    /** Net of gap-merge gaps. */
    durationS: nonNegative,
    role: z.enum(['driver', 'passenger']),
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
     * Google encoded polyline, simplified, roughly 200 m trimmed at each end; '' when nothing is
     * left. Its characters are ASCII 63–126, so the length in code units is the length in bytes.
     */
    polyline: z.string().max(MAX_POLYLINE_BYTES),
    /** Storage object name under the user's prefix, `<clientTripId>.bin.gz`; null when no trace was written. */
    tracePath: z.string().min(1).max(256).nullable(),
    /** A scored speeding event at or beyond `SEVERE_SPEEDING_OVER_MPS`, or any L3 alert (§9.9 safe day). */
    hadSevereEvent: z.boolean(),
  })
  .strict()
  .refine((p) => p.endedAt >= p.startedAt, { error: 'endedAt precedes startedAt', path: ['endedAt'] });

export type PayloadEvent = z.infer<typeof PayloadEventSchema>;
export type FinalizeTripPayload = z.infer<typeof FinalizeTripPayloadSchema>;
