// Bridge validation for everything native hands to JS (R2's row contract first of all).
//
// Rows reuse M1's strict `featureRowSchema` (every key required, unknown keys rejected, finite
// numbers only — zod 4's `z.number()` refuses NaN and ±Infinity) and add the one rule the bridge
// adds: `ts` is a non-negative integer epoch ms, because the upload contract accepts only whole
// milliseconds.
import { z } from 'zod';
import { featureRowSchema } from '../../../src/core/replay/trace';
import type {
  DriveSenseState,
  ExitInfo,
  FeatureRow,
  MotionActivity,
  ThermalLevel,
} from './types';

const epochMs = z.number().int().nonnegative();

export const rowWireSchema: z.ZodType<FeatureRow> = featureRowSchema.refine(
  (r) => Number.isSafeInteger(r.ts) && r.ts >= 0,
  { message: 'ts must be an integer epoch ms', path: ['ts'] }
);

/**
 * The precision each numeric `FeatureRow` field is kept to, as a number of decimal places (ruling
 * D2 concern 1). Native emits unrounded doubles whose last digits are sensor noise; noise does not
 * compress, so a trace of raw doubles gzips to ~30 % where these precisions give ~15 %. Every step
 * is far below the sensor's own noise, so no detector can tell the difference, and rounding here —
 * where the row enters JS — means the engine, SQLite, the uploaded trace and `rows_digest` all see
 * the same values. `ts` is an integer and is not in the table; booleans are untouched.
 *
 * - lat/lng 1e-6° (~0.1 m); speed and speed accuracy 0.01 m/s; course 0.1°; hAcc 0.1 m;
 *   altitude 0.1 m;
 * - accelerometer-derived (g, and jerk in g/s) 1e-3; gyro-derived (rad/s) 1e-3;
 * - every other float (0..1 scores, orientation change in rad) 1e-3.
 */
export const ROW_DECIMALS = {
  lat: 6,
  lng: 6,
  hAcc: 1,
  speed: 2,
  speedAcc: 2,
  course: 1,
  alt: 1,
  aLonMax: 3,
  aLonMin: 3,
  aLatMax: 3,
  aLatMin: 3,
  jerkMax: 3,
  yawRateMax: 3,
  gravityStability: 3,
  orientationDelta: 3,
  handlingScore: 3,
} as const satisfies Record<Exclude<NumericRowKey, 'ts'>, number>;

type NumericRowKey = { [K in keyof FeatureRow]: FeatureRow[K] extends number ? K : never }[keyof FeatureRow];

const POW10 = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000] as const;

/**
 * `x` to `decimals` places. Integer ÷ power of ten is correctly rounded, so the result is the double
 * nearest the decimal and prints with at most `decimals` digits (no `0.30000000000000004`). The
 * sentinels survive (-1, 0, 9999), and -0 becomes 0.
 */
export function roundTo(x: number, decimals: number): number {
  const p = POW10[decimals] ?? 10 ** decimals;
  const r = Math.round(x * p) / p;
  return r === 0 ? 0 : r;
}

/**
 * The row if it is exactly a valid `FeatureRow`, as a fresh object with every numeric field
 * rounded to `ROW_DECIMALS`, else null. Never throws.
 */
export function parseRow(raw: unknown): FeatureRow | null {
  const parsed = rowWireSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  for (const key of Object.keys(ROW_DECIMALS) as (keyof typeof ROW_DECIMALS)[]) {
    row[key] = roundTo(row[key], ROW_DECIMALS[key]);
  }
  return row;
}

export const captureModeSchema = z.enum(['mounted', 'pocket', 'auto']);
export const captureRateSchema = z.enum(['full', 'low']);
export const thermalLevelSchema: z.ZodType<ThermalLevel> = z.enum([
  'nominal',
  'fair',
  'serious',
  'critical',
]);

export const stateSchema: z.ZodType<DriveSenseState> = z.strictObject({
  armed: z.boolean(),
  capturing: z.boolean(),
  rate: captureRateSchema.nullable(),
  mode: captureModeSchema.nullable(),
  platform: z.enum(['ios', 'android']),
  location: z.enum(['none', 'whenInUse', 'always']),
  motion: z.enum(['granted', 'denied', 'undetermined', 'unavailable']),
  lockSignal: z.enum(['reliable', 'lagged', 'unreliable']),
  captureWasOpen: z.boolean(),
  captureStartedAt: epochMs.nullable(),
  lastRowTs: epochMs.nullable(),
});

export const motionActivitySchema: z.ZodType<MotionActivity> = z.strictObject({
  type: z.enum(['automotive', 'walking', 'running', 'cycling', 'stationary', 'unknown']),
  confidence: z.enum(['low', 'medium', 'high']),
  ts: epochMs,
});

export const screenStateSchema = z.strictObject({ locked: z.boolean(), on: z.boolean() });

export const motionPermissionSchema = z.enum(['granted', 'denied', 'unavailable']);

export const exitInfoSchema: z.ZodType<ExitInfo> = z.strictObject({
  ts: epochMs,
  reason: z.enum(['user_stopped', 'low_memory', 'crash', 'anr', 'watchdog', 'other', 'unknown']),
  whileCapturing: z.boolean(),
});

export const notificationStateSchema = z.strictObject({
  stationary: z.boolean(),
  startedAt: epochMs.nullable(),
});
