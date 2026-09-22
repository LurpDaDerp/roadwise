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

/** The row if it is exactly a valid `FeatureRow` (a fresh object), else null. Never throws. */
export function parseRow(raw: unknown): FeatureRow | null {
  const parsed = rowWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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
