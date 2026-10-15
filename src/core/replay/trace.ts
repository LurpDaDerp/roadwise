// The replay trace format: one synthetic 1 Hz drive plus the events it must produce.
//
// A trace is JSON on disk (`src/core/__fixtures__/traces/*.json`), so the schema is the only thing
// standing between a hand-edited fixture and a green test that proves nothing: every field is
// required unless the harness genuinely treats it as optional, and unknown keys are rejected.
import type { EventType, Tier } from '@scoring';
import { z } from 'zod';

import { UNKNOWN_LIMIT } from '../detectors/common';
import type { FeatureRow, LimitSample } from '../engine/types';

/** The speed limit in force from `fromTs` until the next entry. */
export interface LimitEntry extends LimitSample {
  /** epoch ms */
  fromTs: number;
}

/** One assertion about the events a trace produces. */
export interface Expectation {
  type: EventType;
  /** epoch ms the event should start at, within `toleranceS` */
  startsNear: number;
  /** seconds either side of `startsNear`; `DEFAULT_TOLERANCE_S` when omitted */
  toleranceS?: number;
  tier?: Tier;
  durationMin?: number;
  durationMax?: number;
  stoppedInTraffic?: boolean;
  /** no event of this type anywhere in the trace */
  absent?: true;
}

// eyes_off and drowsy come only from the DashPal dashcam: no phone trace ever raises them, but an
// expectation may still name one (e.g. as `absent`).
const EVENT_TYPES = ['speeding', 'hard_brake', 'hard_accel', 'hard_corner', 'phone_pickup', 'phone_handling', 'eyes_off', 'drowsy'] as const;
const TIERS = ['minor', 'moderate', 'severe'] as const;

/** Annotated with the engine's own types, so a field added to `FeatureRow` and forgotten here fails `tsc`. */
export const featureRowSchema: z.ZodType<FeatureRow> = z.strictObject({
  ts: z.number(),
  lat: z.number(),
  lng: z.number(),
  hAcc: z.number(),
  speed: z.number(),
  speedAcc: z.number(),
  course: z.number(),
  alt: z.number(),
  gnssValid: z.boolean(),
  aLonMax: z.number(),
  aLonMin: z.number(),
  aLatMax: z.number(),
  aLatMin: z.number(),
  yawRateMax: z.number(),
  jerkMax: z.number(),
  gravityStability: z.number(),
  orientationDelta: z.number(),
  handlingScore: z.number(),
  locked: z.boolean(),
  screenOn: z.boolean(),
  appForeground: z.boolean(),
  mock: z.boolean().optional(),
});

export const limitEntrySchema: z.ZodType<LimitEntry> = z.strictObject({
  fromTs: z.number(),
  limitMps: z.number().nullable(),
  source: z.enum(['posted', 'statutory', 'cached', 'unknown']),
  matchConfidence: z.number().min(0).max(1),
  parallelRoads: z.boolean(),
});

export const expectationSchema: z.ZodType<Expectation> = z.strictObject({
  type: z.enum(EVENT_TYPES),
  startsNear: z.number(),
  toleranceS: z.number().nonnegative().optional(),
  tier: z.enum(TIERS).optional(),
  durationMin: z.number().nonnegative().optional(),
  durationMax: z.number().nonnegative().optional(),
  stoppedInTraffic: z.boolean().optional(),
  absent: z.literal(true).optional(),
});

export const traceSchema = z.strictObject({
  name: z.string().min(1),
  /** A hands-free call is active for the whole trace. */
  callActive: z.boolean().optional(),
  rows: z.array(featureRowSchema).min(1),
  limits: z.array(limitEntrySchema),
  expected: z.array(expectationSchema),
  /** The drive must produce no events at all. */
  noEvents: z.literal(true).optional(),
});

export type Trace = z.infer<typeof traceSchema>;

/** The limit in force at `ts`: the latest entry that had already started. A row before the first entry is unknown. */
export function limitAt(limits: readonly LimitEntry[], ts: number): LimitSample {
  let best: LimitEntry | null = null;
  for (const entry of limits) {
    if (entry.fromTs <= ts && (best === null || entry.fromTs > best.fromTs)) best = entry;
  }
  if (!best) return UNKNOWN_LIMIT;
  const { limitMps, source, matchConfidence, parallelRoads } = best;
  return { limitMps, source, matchConfidence, parallelRoads };
}

/** Parse a trace from JSON, naming every problem at once. */
export function parseTrace(value: unknown): Trace {
  const parsed = traceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'trace'}: ${issue.message}`).join('; ');
  throw new Error(`Invalid trace: ${details}`);
}
