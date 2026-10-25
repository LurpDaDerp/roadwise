// The `finalize-trip` upload contract (v5), the v4 and v3 contracts older builds still send, and
// the `trip-actions` request and answer shapes.
//
// This file is the contract's single source: the device validates what it queues against it and
// the edge functions validate what they receive against a byte-identical copy (`_shared/payload.ts`,
// synced by `scripts/sync-scoring.js`). So it must stay self-contained: zod only — no `@/`
// alias, no `@scoring`, no React Native, no Node built-ins. The event shape mirrors `DriveEvent`
// and the exposure mirrors `Exposure` in packages/scoring; packages/scoring/__tests__/payload.test.ts
// pins that they stay assignable both ways.
//
// Every request object is `strict()`: a key the contract does not know is drift between the two
// ends, not data, and is better refused on the device than 400'd by the server.
import { z } from 'zod';

/** The server refuses more events than this; the finalizer trims the upload to fit. */
export const MAX_EVENTS = 500;
/** The server refuses a longer polyline; the finalizer re-simplifies until it fits. */
export const MAX_POLYLINE_BYTES = 16_384;

/**
 * A time zone NAME (IANA: `America/New_York`, `Etc/GMT+5`, `UTC`), never a fixed offset such as
 * `+05:00` or `UTC+5`: V8 and Postgres read an offset's sign oppositely, so an offset would put the
 * server's local day a day away from the device's. The first segment is letters only.
 */
export const TZ_NAME_PATTERN = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/;

const epochMs = z.number().int().nonnegative();
const nonNegative = z.number().nonnegative();

/** The server refuses a request body larger than this. */
export const MAX_PAYLOAD_BYTES = 524_288;
/** The longest drive the server accepts, start to end. */
export const MAX_DRIVE_MS = 12 * 3_600_000;
/** Most extra blocks a v3 event may claim. */
export const MAX_EVENT_UNITS = 1440;
/** Slack for an event's end past the drive's end, and for durationS against the wall span. */
const EVENT_END_SLACK_MS = 2000;
export const DURATION_SLACK_S = 5;
/**
 * The route: encoded-polyline runs (ASCII 63–126, so length in code units is length in bytes)
 * joined by single spaces — one run per visible stretch between privacy cuts, never a chord across
 * one. Empty, or runs with no leading, trailing or doubled space.
 */
const POLYLINE_PATTERN = /^(?:[\x3F-\x7E]+(?: [\x3F-\x7E]+)*)?$/;
/** The server refuses a route in more runs than this (≤ 3 zones give ≤ 4; a re-entered zone a few more). */
export const MAX_POLYLINE_RUNS = 20;
const runCount = (s: string): number => (s === '' ? 0 : s.split(' ').length);

const DAY_MS = 86_400_000;

/** The event types a drive records (mirrors `EventType` in the scoring package). */
export const EVENT_TYPES = ['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'eyes_off', 'drowsy'] as const;
/** The event types a v4 upload may carry: v5's without the phone pickup. */
export const EVENT_TYPES_V4 = [
  'speeding',
  'hard_brake',
  'hard_accel',
  'hard_corner',
  'eyes_off',
  'drowsy',
] as const satisfies readonly (typeof EVENT_TYPES)[number][];
export const TIERS = ['minor', 'moderate', 'severe'] as const;
/** The types only the DashPal dashcam reports (mirrors DASHCAM_EVENT_TYPES in the scoring package). */
export const DASHCAM_EVENT_TYPES_WIRE = ['eyes_off', 'drowsy'] as const satisfies readonly (typeof EVENT_TYPES)[number][];
const isDashcamWireType = (type: string): boolean => (DASHCAM_EVENT_TYPES_WIRE as readonly string[]).includes(type);

/** The tiers each event type can have. */
export const TIERS_BY_TYPE: Record<(typeof EVENT_TYPES)[number], readonly (typeof TIERS)[number][]> = {
  speeding: ['minor', 'moderate', 'severe'],
  hard_brake: ['minor', 'severe'],
  hard_accel: ['minor', 'severe'],
  hard_corner: ['minor', 'severe'],
  /** In hand up to 15 s moderate, longer severe (scoring `phonePickupTier`). */
  phone_pickup: ['moderate', 'severe'],
  eyes_off: ['severe'],
  drowsy: ['severe'],
};

const roundedTo4dp = (v: number): boolean => Number(v.toFixed(4)) === v;

/** A raw first/last fix, rounded to 4 dp. `start` is the drive's first recorded row (its traced-back start). */
export const PointSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict()
  .refine((p) => roundedTo4dp(p.lat) && roundedTo4dp(p.lng), {
    error: 'coordinates must already be rounded to 4 decimal places',
  });

/** The measurements a v4 event may carry. */
const measuredFields = {
  speedMph: z.number().min(0).max(250).optional(),
  limitMph: z.number().min(0).max(120).optional(),
  peakG: z.number().min(0).max(10).optional(),
  /** speeding: mph-seconds over the speeding line, every over row (the Speed weight reads it). */
  overMphS: z.number().min(0).max(1_000_000).optional(),
  /** Who saw it: `dashcam` on (and only on) a DashPal event. */
  source: z.literal('dashcam').optional(),
};

/** What the detector measured; shown on the recap, re-checked by the server. */
export const MeasuredSchema = z
  .object({
    ...measuredFields,
    /** phone_pickup: the highest trusted GPS speed from its start to its last use row, mph. */
    maxSpeedMph: z.number().min(0).max(250).optional(),
  })
  .strict();
/** A v4 event's measurements: v5's without `maxSpeedMph`. */
export const MeasuredV4Schema = z.object(measuredFields).strict();

/** The fields of an event every upload version shares. */
const eventFields = {
  id: z.uuid(),
  tier: z.enum(TIERS),
  startedAt: epochMs,
  durationS: z.number().min(0).max(MAX_DRIVE_MS / 1000),
  zone: z.enum(['school', 'construction']).nullable().optional(),
  /** Only the server removes an event (an accepted dispute); an upload is always active. */
  status: z.literal('active').optional(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
};

/**
 * One event: a `DriveEvent` plus where it happened (null inside a privacy zone) and its
 * measurements. A phone pickup's `durationS` is its seconds in hand: a whole number, at least 1.
 */
export const PayloadEventSchema = z
  .object({ ...eventFields, type: z.enum(EVENT_TYPES), measured: MeasuredSchema })
  .strict()
  .refine((e) => TIERS_BY_TYPE[e.type].includes(e.tier), {
    error: 'tier not allowed for this event type',
    path: ['tier'],
  })
  .refine((e) => isDashcamWireType(e.type) === (e.measured.source === 'dashcam'), {
    error: 'a DashPal event carries source dashcam, and only a DashPal event does',
    path: ['measured', 'source'],
  })
  .refine((e) => e.type !== 'phone_pickup' || (Number.isInteger(e.durationS) && e.durationS >= 1), {
    error: 'a phone pickup is in hand a whole number of seconds, at least 1',
    path: ['durationS'],
  });

/** A v4 event: no phone pickup, no `maxSpeedMph`. */
export const PayloadEventV4Schema = z
  .object({ ...eventFields, type: z.enum(EVENT_TYPES_V4), measured: MeasuredV4Schema })
  .strict()
  .refine((e) => TIERS_BY_TYPE[e.type].includes(e.tier), {
    error: 'tier not allowed for this event type',
    path: ['tier'],
  })
  .refine((e) => isDashcamWireType(e.type) === (e.measured.source === 'dashcam'), {
    error: 'a DashPal event carries source dashcam, and only a DashPal event does',
    path: ['measured', 'source'],
  });

/** The longest a drive can be moving, in seconds (the 12 h drive bound). */
const MAX_DRIVE_S = MAX_DRIVE_MS / 1000;

/**
 * The DashPal seconds of a drive, sent only when a paired dashcam covered some of it (absent: no
 * DashPal). The server derives the DashPal drive from them (scoring `dashcamDrive`).
 */
export const DashcamSchema = z
  .object({
    /** The dashcam's identity MAC, lowercase hex. */
    deviceId: z.string().regex(/^[0-9a-f]{12}$/),
    /** Seconds moving at 5 mph or more. */
    movingS: z.number().int().min(0).max(MAX_DRIVE_S),
    /** Of those, seconds the dashcam watched a live face on this phone's link. */
    coveredS: z.number().int().min(0),
    /** Every dashcam event was persisted within 30 s of the drive's end. */
    synced: z.boolean(),
  })
  .strict()
  .refine((d) => d.coveredS <= d.movingS, { error: 'coveredS exceeds movingS', path: ['coveredS'] });

/** Most of each counted opportunity a drive may claim (mirrors `EXPOSURE_MAX.count` in the scoring package). */
const MAX_EXPOSURE_COUNT = 20_000;

/** The opportunity counters a v4 upload carries. */
const exposureFields = {
  slowdowns: z.number().int().min(0).max(MAX_EXPOSURE_COUNT),
  speedups: z.number().int().min(0).max(MAX_EXPOSURE_COUNT),
  turns: z.number().int().min(0).max(MAX_EXPOSURE_COUNT),
  limitS: z.number().int().min(0).max(MAX_DRIVE_S),
  movingS: z.number().int().min(0).max(MAX_DRIVE_S),
};

/**
 * The drive's opportunity counters (scoring `Exposure`), with `phoneS` (seconds at driving speed
 * with the motion sensors read) required. Optional on the upload: a drive upgraded from v3 has none
 * and the server estimates them from its miles and duration (with no phone seconds).
 */
export const ExposureSchema = z
  .object({ ...exposureFields, phoneS: z.number().int().min(0).max(MAX_DRIVE_S) })
  .strict()
  .refine((e) => e.limitS <= e.movingS, { error: 'limitS exceeds movingS', path: ['limitS'] })
  .refine((e) => e.phoneS <= e.movingS, { error: 'phoneS exceeds movingS', path: ['phoneS'] });
/** A v4 upload's counters: no `phoneS` (it reads 0). */
export const ExposureV4Schema = z
  .object(exposureFields)
  .strict()
  .refine((e) => e.limitS <= e.movingS, { error: 'limitS exceeds movingS', path: ['limitS'] });

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

/** The facts every upload version shares. */
const driveFields = {
  clientTripId: z.uuid(),
  startedAt: epochMs,
  endedAt: epochMs,
  /** IANA time zone name, never an offset (`TZ_NAME_PATTERN`). */
  tz: z.string().min(1).max(64).regex(TZ_NAME_PATTERN),
  /** Device-local date of startedAt. */
  localDay: z.string().refine((s) => dayNumber(s) !== null, { error: 'localDay must be a real YYYY-MM-DD date' }),
  miles: z.number().min(0).max(1000),
  nightMiles: nonNegative,
  durationS: z.number().min(0).max(MAX_DRIVE_MS / 1000),
  start: PointSchema.nullable(),
  end: PointSchema.nullable(),
  /** Google encoded polyline runs, space-joined, trimmed on the device (privacy zones + the first and last 402 m). ASCII only. */
  polyline: z
    .string()
    .max(MAX_POLYLINE_BYTES)
    .regex(POLYLINE_PATTERN)
    .refine((s) => runCount(s) <= MAX_POLYLINE_RUNS, { message: `at most ${MAX_POLYLINE_RUNS} runs` }),
  integrity: z
    .object({
      mockLocation: z.boolean(),
      motionMismatch: z.boolean(),
      validGnssPct: z.number().min(0).max(100),
      maxSpeedMph: z.number().min(0).max(300),
    })
    .strict(),
  appVersion: z.string().min(1).max(32),
  /** Optional: an app without DashPal (or a drive no dashcam covered) leaves it out. */
  dashcam: DashcamSchema.optional(),
};

/** The checks every upload version shares, over its drive facts and events. */
interface DriveFacts {
  startedAt: number;
  endedAt: number;
  durationS: number;
  miles: number;
  nightMiles: number;
  localDay: string;
  events: readonly { id: string; startedAt: number; durationS: number }[];
}
const driveIssues = (p: DriveFacts, ctx: z.RefinementCtx): void => {
  const issue = (message: string, path: string): void => ctx.addIssue({ code: 'custom', message, path: [path] });
  if (!(p.endedAt > p.startedAt)) issue('endedAt must be after startedAt', 'endedAt');
  if (p.endedAt - p.startedAt > MAX_DRIVE_MS) issue('a drive lasts at most 12 h', 'endedAt');
  if (!(Math.abs(p.durationS - (p.endedAt - p.startedAt) / 1000) <= DURATION_SLACK_S)) {
    issue('durationS must match endedAt − startedAt within 5 s', 'durationS');
  }
  if (p.nightMiles > p.miles) issue('nightMiles exceeds miles', 'nightMiles');
  // Every real time zone puts the local date within one day of the UTC date.
  const day = dayNumber(p.localDay);
  if (!(day !== null && Math.abs(day - Math.floor(p.startedAt / DAY_MS)) <= 1)) {
    issue('localDay is not the date of startedAt in any time zone', 'localDay');
  }
  if (!p.events.every((e) => e.startedAt >= p.startedAt && e.startedAt <= p.endedAt)) issue('every event must start within the drive', 'events');
  if (!p.events.every((e) => e.startedAt + e.durationS * 1000 <= p.endedAt + EVENT_END_SLACK_MS)) issue('every event must end by endedAt', 'events');
  if (new Set(p.events.map((e) => e.id)).size !== p.events.length) issue('event ids must be unique', 'events');
};

/** The facts a v4 and a v5 upload share beside the drive's. */
const lifecycleFields = {
  /** How the drive started: noticed on its own, or a Start tap. */
  origin: z.enum(['auto', 'manual']),
  /** The in-drive "Not driving?" ran out of its 2-minute visibility budget. */
  notDrivingExpired: z.boolean(),
};

const exposureIssues = (p: { durationS: number; exposure?: { movingS: number } }, ctx: z.RefinementCtx): void => {
  if (p.exposure !== undefined && p.exposure.movingS > p.durationS + DURATION_SLACK_S) {
    ctx.addIssue({ code: 'custom', message: 'exposure movingS exceeds the drive', path: ['exposure', 'movingS'] });
  }
};

/**
 * The upload a drive sends to `finalize-trip`: v4 plus the phone pickups and the seconds at
 * driving speed they are judged over (`exposure.phoneS`). A pickup is in hand no longer than the
 * drive lasts (its whole seconds, as the server stores them).
 */
export const FinalizeTripPayloadV5Schema = z
  .object({
    v: z.literal(5),
    ...driveFields,
    events: z.array(PayloadEventSchema).max(MAX_EVENTS),
    ...lifecycleFields,
    /** The drive's opportunity counters (`ExposureSchema`). Optional: an upgraded v3 drive has none. */
    exposure: ExposureSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    driveIssues(p, ctx);
    exposureIssues(p, ctx);
    if (!p.events.every((e) => e.type !== 'phone_pickup' || e.durationS <= Math.round(p.durationS))) {
      ctx.addIssue({ code: 'custom', message: 'a phone pickup is in hand no longer than the drive', path: ['events'] });
    }
  });

// --- v4: what a build from before phone tracking sends (or still has queued). Upgraded to v5 by
// `upgradePayloadV4`. ---

export const FinalizeTripPayloadV4Schema = z
  .object({
    v: z.literal(4),
    ...driveFields,
    events: z.array(PayloadEventV4Schema).max(MAX_EVENTS),
    ...lifecycleFields,
    /** The drive's opportunity counters, without phoneS. Optional: an upgraded v3 drive has none. */
    exposure: ExposureV4Schema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    driveIssues(p, ctx);
    exposureIssues(p, ctx);
  });

// --- v3: what an older build sends (or still has queued). Upgraded to v4 by `upgradePayloadV3`. ---

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
const TIERS_BY_TYPE_V3: Record<(typeof EVENT_TYPES_V3)[number], readonly (typeof TIERS)[number][]> = {
  ...TIERS_BY_TYPE,
  /** A v3 pickup (screen switches, a different rule) never reaches v4. */
  phone_pickup: ['severe'],
  phone_handling: ['moderate', 'severe'],
};

/** A v3 event's measurements: v4's plus the phone-use keys. */
export const MeasuredV3Schema = z
  .object({
    speedMph: z.number().min(0).max(250).optional(),
    limitMph: z.number().min(0).max(120).optional(),
    peakG: z.number().min(0).max(10).optional(),
    mounted: z.boolean().optional(),
    maxSpeedMph: z.number().min(0).max(250).optional(),
    overMphS: z.number().min(0).max(1_000_000).optional(),
    source: z.literal('dashcam').optional(),
  })
  .strict();

export const PayloadEventV3Schema = z
  .object({
    id: z.uuid(),
    type: z.enum(EVENT_TYPES_V3),
    tier: z.enum(TIERS),
    startedAt: epochMs,
    durationS: z.number().min(0).max(MAX_DRIVE_MS / 1000),
    units: z.number().int().min(0).max(MAX_EVENT_UNITS).optional(),
    stoppedInTraffic: z.boolean().optional(),
    zone: z.enum(['school', 'construction']).nullable().optional(),
    status: z.literal('active').optional(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    measured: MeasuredV3Schema,
  })
  .strict()
  .refine((e) => TIERS_BY_TYPE_V3[e.type].includes(e.tier), {
    error: 'tier not allowed for this event type',
    path: ['tier'],
  })
  .refine((e) => e.type !== 'phone_handling' || e.units === undefined || e.units >= 1, {
    error: 'phone handling counts at least 1 unit',
    path: ['units'],
  })
  .refine((e) => isDashcamWireType(e.type) === (e.measured.source === 'dashcam'), {
    error: 'a DashPal event carries source dashcam, and only a DashPal event does',
    path: ['measured', 'source'],
  });

export const FinalizeTripPayloadV3Schema = z
  .object({
    v: z.literal(3),
    ...driveFields,
    safeMiles: nonNegative,
    events: z.array(PayloadEventV3Schema).max(MAX_EVENTS),
  })
  .strict()
  .superRefine((p, ctx) => {
    driveIssues(p, ctx);
    if (p.safeMiles > p.miles) ctx.addIssue({ code: 'custom', message: 'safeMiles exceeds miles', path: ['safeMiles'] });
  });

export type PayloadEvent = z.infer<typeof PayloadEventSchema>;
export type PayloadDashcam = z.infer<typeof DashcamSchema>;
export type ExposureWire = z.infer<typeof ExposureSchema>;
export type FinalizeTripPayloadV5 = z.infer<typeof FinalizeTripPayloadV5Schema>;
export type PayloadEventV4 = z.infer<typeof PayloadEventV4Schema>;
export type ExposureWireV4 = z.infer<typeof ExposureV4Schema>;
export type FinalizeTripPayloadV4 = z.infer<typeof FinalizeTripPayloadV4Schema>;
export type PayloadEventV3 = z.infer<typeof PayloadEventV3Schema>;
export type FinalizeTripPayloadV3 = z.infer<typeof FinalizeTripPayloadV3Schema>;

/**
 * A v3 upload (an older build, or one still queued from it) as v4: phone events go, with the
 * fields only they used (`units`, `stoppedInTraffic`, `measured.mounted`, `measured.maxSpeedMph`);
 * `safeMiles` goes; the drive reads as started from Start (`origin: 'manual'`) with its
 * "Not driving?" never run out; no exposure (the server estimates it). Pure.
 */
export function upgradePayloadV3(p: FinalizeTripPayloadV3): FinalizeTripPayloadV4 {
  const { v: _v, safeMiles: _safe, events, ...rest } = p;
  const kept: PayloadEventV4[] = [];
  for (const e of events) {
    const { units: _u, stoppedInTraffic: _st, measured, type, ...event } = e;
    if (type === 'phone_pickup' || type === 'phone_handling') continue;
    const { mounted: _m, maxSpeedMph: _x, ...m } = measured;
    kept.push({ ...event, type, measured: m });
  }
  return { ...rest, v: 4, origin: 'manual', notDrivingExpired: false, events: kept };
}

/**
 * A v4 upload (a build from before phone tracking, or one still queued from it) as v5: its events
 * as they are (it has no pickups) and, when it sent counters, no phone seconds (`phoneS: 0`: the
 * drive was not watched for phone use, so Phone use has no score from it). Pure.
 */
export function upgradePayloadV4(p: FinalizeTripPayloadV4): FinalizeTripPayloadV5 {
  const { v: _v, exposure, ...rest } = p;
  return exposure === undefined ? { ...rest, v: 5 } : { ...rest, v: 5, exposure: { ...exposure, phoneS: 0 } };
}

/** A v4 body read as v5: validated as v4, upgraded, then held to v5. */
const UpgradedV4Schema = FinalizeTripPayloadV4Schema.transform(upgradePayloadV4).pipe(FinalizeTripPayloadV5Schema);
/** A v3 body read as v5: validated as v3, upgraded to v4 and held to it, then to v5 the same way. */
const UpgradedV3Schema = FinalizeTripPayloadV3Schema.transform(upgradePayloadV3).pipe(UpgradedV4Schema);

/**
 * Reads a queued or received upload: `v: 3` and `v: 4` are validated as sent and upgraded; anything
 * else is held to v5 (so an unknown version's refusal names the path `v`, which a phone reads as a
 * server behind it).
 */
export function parseFinalizeUpload(body: unknown): z.ZodSafeParseResult<FinalizeTripPayloadV5> {
  const v = typeof body === 'object' && body !== null ? (body as { v?: unknown }).v : undefined;
  if (v === 3) return UpgradedV3Schema.safeParse(body);
  if (v === 4) return UpgradedV4Schema.safeParse(body);
  return FinalizeTripPayloadV5Schema.safeParse(body);
}

/** A Safety Rating as the server now holds it. */
const RatingWireSchema = z.object({
  safetyRating: z.number().min(0).max(100).nullable(),
  ranked: z.boolean(),
});

/** What `finalize-trip` returns; the client stores it as the local trip's `result_json`. Idempotent on clientTripId. */
export const FinalizeTripResponseSchema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  /** Always null from this server; an older server's answer may name the drive it joined this upload into. */
  mergedInto: z.uuid().nullable(),
  scored: z.boolean(),
  reason: z.enum(['too_short', 'spoofed', 'implausible']).nullable(),
  /** Every event the stored drive keeps: the phone drops a DashPal event the server did not keep. */
  eventIds: z.array(z.uuid()),
  rating: RatingWireSchema,
  /** Weekly goals this drive completed. */
  challenges: z.array(z.object({ id: z.string(), title: z.string() })),
  /** Achievements this drive unlocked. */
  achievements: z.array(z.string()),
});
export type FinalizeTripResponse = z.infer<typeof FinalizeTripResponseSchema>;

// --- trip-actions: dispute one event, or mark a drive as "wasn't driving" ---

/**
 * The report sheet's reasons: `hazard` for a hard brake, `wrong_limit` for speeding, `camera_wrong`
 * for a DashPal event, `mounted` ("My phone was mounted") for a phone pickup; `not_driving` routes to
 * the whole-drive action.
 */
export const DISPUTE_REASONS = ['hazard', 'wrong_limit', 'camera_wrong', 'mounted', 'not_driving'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DisputeActionSchema = z
  .object({ action: z.literal('dispute'), clientTripId: z.uuid(), eventId: z.uuid(), reason: z.enum(DISPUTE_REASONS) })
  .strict();
export const NotDrivingActionSchema = z.object({ action: z.literal('not_driving'), clientTripId: z.uuid() }).strict();
export const TripActionSchema = z.discriminatedUnion('action', [DisputeActionSchema, NotDrivingActionSchema]);
export type TripAction = z.infer<typeof TripActionSchema>;

/** What `not_driving` answers: the uses left this month and the rating as now stored. */
export const NotDrivingResultSchema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  notDrivingLeft: z.number().int().min(0),
  rating: RatingWireSchema,
});
export type NotDrivingResult = z.infer<typeof NotDrivingResultSchema>;

/** What `dispute` answers. */
export const DisputeResultSchema = z.object({
  tripId: z.uuid(),
  eventId: z.uuid(),
  status: z.enum(['accepted', 'rejected']),
  rejectReason: z.literal('quota').nullable(),
  /** Auto-accepts left this week in this reason's quota (hazard + wrong-limit + mounted, or camera_wrong alone). */
  quotaLeft: z.number().int().min(0),
  /** The drive's clean flag as now stored. */
  clean: z.boolean(),
  rating: RatingWireSchema,
});
export type DisputeResult = z.infer<typeof DisputeResultSchema>;
