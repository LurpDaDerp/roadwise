// The replay trace format: one recorded or synthetic 1 Hz drive plus the events it must produce.
//
// A trace is JSON on disk (`src/core/__fixtures__/traces/*.json`), so the schema is the only thing
// standing between a hand-edited fixture and a green test that proves nothing. Every field is
// required unless the harness genuinely treats it as optional, and unknown keys are rejected rather
// than silently dropped — a typo in `toleranceS` would otherwise turn an assertion off.
import { z } from 'zod';
import type { EventCategory } from '@scoring';
import { UNKNOWN_LIMIT } from '../detectors/common';
import type { DriveMode, FeatureRow, LimitSample } from '../engine/types';

/** The speed limit in force from `fromTs` until the next entry (§9.5 speed-limit source). */
export interface LimitEntry extends LimitSample {
  /** epoch ms */
  fromTs: number;
}

/** One assertion about the events a trace produces. */
export interface Expectation {
  category: EventCategory;
  /** epoch ms the event should start at, within `toleranceS` */
  startsNear: number;
  /** seconds either side of `startsNear`; `DEFAULT_TOLERANCE_S` when omitted */
  toleranceS?: number;
  durationMin?: number;
  durationMax?: number;
  qMin?: number;
  qMax?: number;
  /**
   * The status the matching event must carry. Without it a regression that quietly downgrades a
   * scored event to `possible` — and so stops costing the driver anything — still passes.
   */
  status?: 'scored' | 'possible';
  /** no *scored* event of this category anywhere in the trace (a `possible` one is fine) */
  absent?: true;
}

/**
 * The schemas are annotated with the engine's own types, so a field added to `FeatureRow`,
 * `LimitSample` or `Expectation` and forgotten here fails `tsc`, not a fixture at runtime.
 */
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
});

export const limitEntrySchema: z.ZodType<LimitEntry> = z.strictObject({
  fromTs: z.number(),
  limitMps: z.number().nullable(),
  source: z.enum(['posted', 'statutory', 'cached', 'unknown']),
  matchConfidence: z.number().min(0).max(1),
  parallelRoads: z.boolean(),
});

export const expectationSchema: z.ZodType<Expectation> = z.strictObject({
  category: z.enum(['phone', 'speeding', 'braking', 'accel', 'cornering', 'focus']),
  startsNear: z.number(),
  toleranceS: z.number().nonnegative().optional(),
  durationMin: z.number().nonnegative().optional(),
  durationMax: z.number().nonnegative().optional(),
  qMin: z.number().min(0).max(1).optional(),
  qMax: z.number().min(0).max(1).optional(),
  // `disputed` and `removed` are dispute-flow states; a detector never produces them.
  status: z.enum(['scored', 'possible']).optional(),
  // A flag, not a switch: `absent: false` would read like "this must happen" and assert nothing.
  absent: z.literal(true).optional(),
});

const driveMode: z.ZodType<DriveMode> = z.enum(['mounted', 'pocket', 'auto']);

export const traceSchema = z.strictObject({
  name: z.string().min(1),
  mode: driveMode,
  night: z.boolean(),
  precipitation: z.boolean(),
  /**
   * How far the rows' `locked` / `screenOn` can be believed (drive-sense `lockSignal`); absent
   * means `reliable`. Becomes the detector context's `lockReliable` / `lockLagged`.
   */
  lockSignal: z.enum(['reliable', 'lagged', 'unreliable']).optional(),
  rows: z.array(featureRowSchema).min(1),
  limits: z.array(limitEntrySchema),
  expected: z.array(expectationSchema),
  /**
   * The drive must produce no events at all — not even a `possible` one. A list of `absent`
   * expectations only says "nothing scored", which a new false positive would slip past.
   */
  noEvents: z.literal(true).optional(),
});

export type Trace = z.infer<typeof traceSchema>;

/**
 * The limit in force at `ts`: the latest entry that had already started. Order-independent. A
 * row before the first `LimitEntry` is fed `UNKNOWN_LIMIT`.
 */
export function limitAt(limits: readonly LimitEntry[], ts: number): LimitSample {
  let best: LimitEntry | null = null;
  for (const entry of limits) {
    if (entry.fromTs <= ts && (best === null || entry.fromTs > best.fromTs)) best = entry;
  }
  if (!best) return UNKNOWN_LIMIT;
  const { limitMps, source, matchConfidence, parallelRoads } = best;
  return { limitMps, source, matchConfidence, parallelRoads };
}

/** Parse a trace from JSON, naming every problem at once. Throws on anything the harness cannot run. */
export function parseTrace(value: unknown): Trace {
  const parsed = traceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Zod's default message ("invalid type") is useless without the path, and a fixture is big
  // enough that "which field" is the whole answer.
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'trace'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid trace: ${details}`);
}
