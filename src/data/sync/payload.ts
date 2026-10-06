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
/** @deprecated v2 — removed by WP6/WP5 */
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

/** @deprecated v2 — removed by WP6/WP5 */
export const ContextSchema = z.object({ night: z.boolean(), precipitation: z.boolean() }).strict();

/**
 * One event: a `ScorableEvent` (so the server can re-score it as the device did) plus the
 * server's `trip_events` columns that are derived from it — `durationMs`, `severity`,
 * `contextMultiplier`, `deduction`, the 3 dp coordinates, `alertShown` and `source`.
 */
/** @deprecated v2 — removed by WP6/WP5 */
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
/** @deprecated v2 — removed by WP6/WP5 */
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
/** @deprecated v2 — removed by WP6/WP5 */
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

/** @deprecated v2 — removed by WP6/WP5 */
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

/** @deprecated v2 — removed by WP6/WP5 */
export type PayloadEvent = z.infer<typeof PayloadEventSchema>;
/** @deprecated v2 — removed by WP6/WP5 */
export type FinalizeTripPayload = z.infer<typeof FinalizeTripPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// v3 upload contract (plan §3). Everything above this line is the v2 contract and is deprecated.
//
// The event shape mirrors `DriveEvent` in packages/scoring/src/drive.ts and the response's
// `breakdown` mirrors `DriveBreakdown`; packages/scoring/__tests__/payloadV3.test.ts pins that
// they stay assignable both ways. This file still imports only zod.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The server refuses a request body larger than this. */
export const MAX_PAYLOAD_BYTES = 524_288;
/** The longest drive the server accepts, start to end. */
export const MAX_DRIVE_MS = 12 * 3_600_000;
/** Most extra blocks an event may claim (mirrors MAX_UNITS in the scoring package). */
export const MAX_EVENT_UNITS = 1440;
/** Slack for an event's end past the drive's end, and for durationS against the wall span. */
const EVENT_END_SLACK_MS = 2000;
const DURATION_SLACK_S = 5;
/** Encoded-polyline characters only (ASCII 63–126), so length in code units is length in bytes. */
const POLYLINE_PATTERN = /^[\x3F-\x7E]*$/;

const DAY_MS = 86_400_000;

export const EVENT_TYPES_V3 = [
  'speeding',
  'hard_brake',
  'hard_accel',
  'hard_corner',
  'phone_pickup',
  'phone_handling',
  'eyes_off',
  'drowsy',
] as const;
export const TIERS_V3 = ['minor', 'moderate', 'severe'] as const;

/** The tiers each event type can have (plan §2). */
export const TIERS_BY_TYPE: Record<(typeof EVENT_TYPES_V3)[number], readonly (typeof TIERS_V3)[number][]> = {
  speeding: ['minor', 'moderate', 'severe'],
  hard_brake: ['minor', 'severe'],
  hard_accel: ['minor', 'severe'],
  hard_corner: ['minor', 'severe'],
  eyes_off: ['minor', 'severe'],
  phone_pickup: ['severe'],
  phone_handling: ['moderate', 'severe'],
  drowsy: ['severe'],
};

const roundedTo4dp = (v: number): boolean => Number(v.toFixed(4)) === v;

/** A raw first/last fix, rounded to 4 dp. Used only for the merge and loop checks. */
export const PointV3Schema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict()
  .refine((p) => roundedTo4dp(p.lat) && roundedTo4dp(p.lng), {
    error: 'coordinates must already be rounded to 4 decimal places',
  });

/** What the detector measured; shown on the summary, re-checked by the server. */
export const MeasuredV3Schema = z
  .object({
    speedMph: z.number().min(0).max(250).optional(),
    limitMph: z.number().min(0).max(120).optional(),
    peakG: z.number().min(0).max(10).optional(),
    mounted: z.boolean().optional(),
  })
  .strict();

/** One event: a `DriveEvent` plus where it happened (null inside a privacy zone) and its measurements. */
export const PayloadEventV3Schema = z
  .object({
    id: z.uuid(),
    type: z.enum(EVENT_TYPES_V3),
    tier: z.enum(TIERS_V3),
    startedAt: epochMs,
    durationS: z.number().min(0).max(MAX_DRIVE_MS / 1000),
    /** phone_handling: 1..1440. Speeding's blocks are derived from durationS by the scorer. */
    units: z.number().int().min(0).max(MAX_EVENT_UNITS).optional(),
    stoppedInTraffic: z.boolean().optional(),
    zone: z.enum(['school', 'construction']).nullable().optional(),
    /** Only the server removes an event (an accepted dispute); an upload is always active. */
    status: z.literal('active').optional(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    measured: MeasuredV3Schema,
  })
  .strict()
  .refine((e) => TIERS_BY_TYPE[e.type].includes(e.tier), {
    error: 'tier not allowed for this event type',
    path: ['tier'],
  })
  .refine((e) => e.type !== 'phone_handling' || e.units === undefined || e.units >= 1, {
    error: 'phone handling counts at least 1 unit',
    path: ['units'],
  });

/** `YYYY-MM-DD` that is a real calendar date → its UTC day number, else null. */
const dayNumber = (s: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
};

export const FinalizeTripPayloadV3Schema = z
  .object({
    v: z.literal(3),
    clientTripId: z.uuid(),
    startedAt: epochMs,
    endedAt: epochMs,
    /** IANA time zone name, never an offset (`TZ_NAME_PATTERN`). */
    tz: z.string().min(1).max(64).regex(TZ_NAME_PATTERN),
    /** Device-local date of startedAt. */
    localDay: z.string().refine((s) => dayNumber(s) !== null, { error: 'localDay must be a real YYYY-MM-DD date' }),
    miles: z.number().min(0).max(1000),
    safeMiles: nonNegative,
    nightMiles: nonNegative,
    durationS: z.number().min(0).max(MAX_DRIVE_MS / 1000),
    dmsOn: z.boolean(),
    dmsFaceSeen: z.boolean(),
    start: PointV3Schema.nullable(),
    end: PointV3Schema.nullable(),
    /** Google encoded polyline, trimmed on the device (privacy zones + first/last 0.25 mi). ASCII only. */
    polyline: z.string().max(MAX_POLYLINE_BYTES).regex(POLYLINE_PATTERN),
    integrity: z
      .object({
        mockLocation: z.boolean(),
        motionMismatch: z.boolean(),
        validGnssPct: z.number().min(0).max(100),
        maxSpeedMph: z.number().min(0).max(300),
      })
      .strict(),
    events: z.array(PayloadEventV3Schema).max(MAX_EVENTS),
    appVersion: z.string().min(1).max(32),
  })
  .strict()
  .refine((p) => p.endedAt > p.startedAt, { error: 'endedAt must be after startedAt', path: ['endedAt'] })
  .refine((p) => p.endedAt - p.startedAt <= MAX_DRIVE_MS, { error: 'a drive lasts at most 12 h', path: ['endedAt'] })
  .refine((p) => Math.abs(p.durationS - (p.endedAt - p.startedAt) / 1000) <= DURATION_SLACK_S, {
    error: 'durationS must match endedAt − startedAt within 5 s',
    path: ['durationS'],
  })
  .refine((p) => p.safeMiles <= p.miles, { error: 'safeMiles exceeds miles', path: ['safeMiles'] })
  .refine((p) => p.nightMiles <= p.miles, { error: 'nightMiles exceeds miles', path: ['nightMiles'] })
  .refine(
    (p) => {
      // Every real time zone puts the local date within one day of the UTC date.
      const day = dayNumber(p.localDay);
      return day !== null && Math.abs(day - Math.floor(p.startedAt / DAY_MS)) <= 1;
    },
    { error: 'localDay is not the date of startedAt in any time zone', path: ['localDay'] }
  )
  .refine((p) => p.events.every((e) => e.startedAt >= p.startedAt && e.startedAt <= p.endedAt), {
    error: 'every event must start within the drive',
    path: ['events'],
  })
  .refine((p) => p.events.every((e) => e.startedAt + e.durationS * 1000 <= p.endedAt + EVENT_END_SLACK_MS), {
    error: 'every event must end by endedAt',
    path: ['events'],
  })
  .refine((p) => new Set(p.events.map((e) => e.id)).size === p.events.length, {
    error: 'event ids must be unique',
    path: ['events'],
  });

/** `DriveBreakdown` from the scoring package, as the server computed it. */
export const DriveBreakdownSchema = z.object({
  scored: z.boolean(),
  reason: z.literal('too_short').optional(),
  safeMiles: nonNegative,
  creditedMiles: nonNegative,
  milePoints: nonNegative,
  cleanBonus: z.union([z.literal(0), z.literal(25)]),
  streakMult: z.number().min(1),
  dmsMult: z.union([z.literal(1), z.literal(1.25)]),
  mult: z.number().min(1),
  gains: z.number().int().nonnegative(),
  shortScale: z.number().min(0).max(1),
  events: z.array(z.object({ id: z.string(), penalty: z.number().int().nonnegative() })),
  penalties: z.number().int().nonnegative(),
  net: z.number().int(),
  ratingPenalty: nonNegative,
  activeEventCount: z.number().int().nonnegative(),
});

export const STREAK_OUTCOMES = ['none', 'grew', 'freeze_used', 'at_risk', 'restored', 'reset'] as const;

/** What `finalize-trip` returns; the client stores it as the local trip's `result_json`. Idempotent on clientTripId. */
export const FinalizeTripResponseV3Schema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  /** clientTripId of the drive this one was merged into. */
  mergedInto: z.uuid().nullable(),
  scored: z.boolean(),
  reason: z.enum(['too_short', 'spoofed', 'implausible']).nullable(),
  breakdown: DriveBreakdownSchema,
  net: z.number().int(),
  streak: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    outcome: z.enum(STREAK_OUTCOMES),
    nextMult: z.number().min(1),
    atRisk: z.boolean(),
    freezes: z.number().int().min(0).max(3),
    freezeEarned: z.boolean(),
  }),
  progress: z.object({
    points: z.number().int(),
    lifetime: z.number().int().nonnegative(),
    level: z.number().int().min(1).max(50),
    levelUp: z.boolean(),
    safetyRating: z.number().min(0).max(100).nullable(),
    ranked: z.boolean(),
  }),
  /** Newly unlocked achievement ids. */
  achievements: z.array(z.string()),
  /** Newly completed weekly challenges. */
  challenges: z.array(z.object({ id: z.string(), title: z.string() })),
  league: z.object({ tier: z.string(), placed: z.boolean() }),
});

export type PayloadEventV3 = z.infer<typeof PayloadEventV3Schema>;
export type FinalizeTripPayloadV3 = z.infer<typeof FinalizeTripPayloadV3Schema>;
export type DriveBreakdownWire = z.infer<typeof DriveBreakdownSchema>;
export type FinalizeTripResponseV3 = z.infer<typeof FinalizeTripResponseV3Schema>;
