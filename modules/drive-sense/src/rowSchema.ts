// Bridge validation for everything native hands to JS (R2's row contract first of all).
//
// Rows reuse M1's strict `featureRowSchema` (every key required, unknown keys rejected, finite
// numbers only — zod 4's `z.number()` refuses NaN and ±Infinity) and add the one rule the bridge
// adds: `ts` is a non-negative integer epoch ms, because the upload contract accepts only whole
// milliseconds.
import { z } from 'zod';
import { featureRowSchema } from '../../../src/core/replay/trace';
import type {
  AudioOutputState,
  CaptureEnd,
  DashpalLinkResult,
  DashpalLinkState,
  InstalledApp,
  DriveDisplayState,
  DriveSenseRow,
  DriveSenseState,
  ExitInfo,
  FeatureRow,
  MotionActivity,
  ReminderLocationAnswer,
  ReminderTap,
  ThermalLevel,
  TripReminderStatus,
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

type NumericRowKey = { [K in keyof FeatureRow]-?: FeatureRow[K] extends number ? K : never }[keyof FeatureRow];

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

/** Every `FeatureRow` key: the 21 of the contract. */
const ROW_KEYS: ReadonlySet<string> = new Set<string>([
  'ts', 'lat', 'lng', 'hAcc', 'speed', 'speedAcc', 'course', 'alt', 'gnssValid',
  'aLonMax', 'aLonMin', 'aLatMax', 'aLatMin', 'yawRateMax', 'jerkMax',
  'gravityStability', 'orientationDelta', 'handlingScore', 'locked', 'screenOn', 'appForeground',
]);

/**
 * The bridge-only key (v3, plan §6): `mock` rides on the `row` payload beside the `FeatureRow`
 * keys. It is not a `FeatureRow` field (the extractor, the trace digest and the golden vectors
 * never see it), so it is split off before the strict row schema runs and re-attached after.
 */
export const MOCK_ROW_KEY = 'mock';

/**
 * The second bridge-only key: `call` (`ring` | `live`), present only while a call rings, dials or
 * is connected (README §1). Split off and re-attached like `mock`; any other value rejects the
 * row. `exempt` is never a bridge key: only the drive host stamps it, so a native one is stripped
 * and counted like any unknown key.
 */
export const CALL_ROW_KEY = 'call';
const CALL_VALUES: ReadonlySet<unknown> = new Set(['ring', 'live']);

let unknownKeys = 0;
/** Unknown row keys stripped since the last reset (diagnostics; C0 round 1, C0-m1). */
export const unknownRowKeys = (): number => unknownKeys;
export function resetUnknownRowKeys(): void {
  unknownKeys = 0;
}

/**
 * The row if it is a valid `FeatureRow`, as a fresh object with every numeric field rounded to
 * `ROW_DECIMALS`, else null. Never throws.
 *
 * Unknown keys fail soft (C0 round 1, review-C0 C0-m1): they are stripped and counted
 * (`unknownRowKeys`), never a dropped row, so a native build that adds a field cannot cost an older
 * bundle a drive's rows. A known key with a wrong type still rejects the row. The exact key contract
 * is pinned by the native text tests and the golden vectors.
 */
export function parseRow(raw: unknown): DriveSenseRow | null {
  let input = raw;
  let mock: boolean | undefined;
  let call: 'ring' | 'live' | undefined;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const entries = Object.entries(raw);
    const m = (raw as Record<string, unknown>)[MOCK_ROW_KEY];
    if (MOCK_ROW_KEY in raw) {
      // A known key with a wrong type rejects the row, like any other.
      if (typeof m !== 'boolean') return null;
      mock = m;
    }
    const c = (raw as Record<string, unknown>)[CALL_ROW_KEY];
    if (CALL_ROW_KEY in raw) {
      if (!CALL_VALUES.has(c)) return null;
      call = c as 'ring' | 'live';
    }
    const extra = entries.filter(([k]) => !ROW_KEYS.has(k) && k !== MOCK_ROW_KEY && k !== CALL_ROW_KEY);
    if (extra.length > 0) unknownKeys += extra.length;
    if (extra.length > 0 || mock !== undefined || call !== undefined) {
      input = Object.fromEntries(entries.filter(([k]) => ROW_KEYS.has(k)));
    }
  }
  const parsed = rowWireSchema.safeParse(input);
  if (!parsed.success) return null;
  const row: DriveSenseRow = parsed.data;
  if (mock !== undefined) row.mock = mock;
  if (call !== undefined) row.call = call;
  for (const key of Object.keys(ROW_DECIMALS) as (keyof typeof ROW_DECIMALS)[]) {
    row[key] = roundTo(row[key], ROW_DECIMALS[key]);
  }
  return row;
}

const ACTIVITY_TYPES: ReadonlySet<string> = new Set<MotionActivity['type']>(['automotive', 'walking', 'running', 'cycling', 'stationary', 'unknown']);
const ACTIVITY_CONFIDENCES: ReadonlySet<string> = new Set<MotionActivity['confidence']>(['low', 'medium', 'high']);

/**
 * An `activity` payload as a fresh `MotionActivity`, or null when it is not one (README §3): a
 * plain object whose `type` is one of the six, `confidence` one of the three and `ts` a safe,
 * non-negative integer epoch ms. `exit` is kept only when it is exactly `true`; every other key is
 * left out. Never throws.
 */
export function parseActivity(raw: unknown): MotionActivity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let type: unknown, confidence: unknown, ts: unknown, exit: unknown;
  try {
    ({ type, confidence, ts, exit } = raw as Record<string, unknown>);
  } catch {
    return null;
  }
  if (typeof type !== 'string' || !ACTIVITY_TYPES.has(type)) return null;
  if (typeof confidence !== 'string' || !ACTIVITY_CONFIDENCES.has(confidence)) return null;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) return null;
  const out: MotionActivity = { type: type as MotionActivity['type'], confidence: confidence as MotionActivity['confidence'], ts };
  if (exit === true) out.exit = true;
  return out;
}

export const captureModeSchema = z.enum(['mounted', 'pocket', 'auto']);
/** `stopCapture`'s drive end: a driving end at or after 0 (or null: not kept), and whether the car was at driving speed. */
export const captureEndSchema: z.ZodType<CaptureEnd> = z.strictObject({
  drivingEndedAt: z.number().finite().nonnegative().nullable(),
  drivingAtEnd: z.boolean(),
});
export const captureRateSchema = z.enum(['full', 'low']);
export const thermalLevelSchema: z.ZodType<ThermalLevel> = z.enum([
  'nominal',
  'fair',
  'serious',
  'critical',
]);

export const stateSchema: z.ZodType<DriveSenseState> = z.strictObject({
  capturing: z.boolean(),
  rate: captureRateSchema.nullable(),
  mode: captureModeSchema.nullable(),
  platform: z.enum(['ios', 'android']),
  location: z.enum(['none', 'whenInUse', 'always']),
  motion: z.enum(['granted', 'denied', 'undetermined', 'unavailable']),
  lockSignal: z.enum(['reliable', 'lagged', 'unreliable']),
  lockProof: z.boolean(),
  lockDelayMs: z.number().int().nonnegative().nullable(),
  captureWasOpen: z.boolean(),
  captureStartedAt: epochMs.nullable(),
  lastRowTs: epochMs.nullable(),
});

/** An Android package name (`com.example.app`): at least two segments, each starting with a letter. */
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** `listInstalledApps` takes at most this many packages at once. */
export const INSTALLED_APPS_MAX = 32;

export const installedAppsSchema: z.ZodType<InstalledApp[]> = z.array(
  z.strictObject({ package: z.string().regex(PACKAGE_NAME), label: z.string().max(200) })
);

export const screenStateSchema = z.strictObject({ locked: z.boolean(), on: z.boolean() });

export const audioOutputSchema: z.ZodType<AudioOutputState> = z.strictObject({
  callActive: z.boolean(),
  volume: z.number().min(0).max(1).nullable(),
  headphones: z.boolean().nullable(),
});

export const dashpalLinkStateSchema: z.ZodType<DashpalLinkState> = z.enum(['off', 'waiting', 'connected']);
export const dashpalLinkResultSchema: z.ZodType<DashpalLinkResult> = z.enum(['running', 'stopped', 'refused', 'unsupported']);

export const motionPermissionSchema = z.enum(['granted', 'denied', 'unavailable']);

export const exitInfoSchema: z.ZodType<ExitInfo> = z.strictObject({
  ts: epochMs,
  reason: z.enum(['user_stopped', 'low_memory', 'crash', 'anr', 'watchdog', 'other', 'unknown']),
  whileCapturing: z.boolean(),
});

/** A display colour: "#RRGGBB", null or absent. */
const skyHex = z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional();

export const driveDisplaySchema: z.ZodType<DriveDisplayState> = z.strictObject({
  speed: z.number().nullable(),
  limit: z.number().nullable(),
  unit: z.enum(['mph', 'km/h']),
  points: z.number().nullable(),
  pointsDelta: z.number().nullable(),
  stopped: z.boolean(),
  ended: z.boolean().optional(),
  skyTop: skyHex,
  skyMid: skyHex,
  skyLow: skyHex,
  accent: skyHex,
});

export const tripReminderStatusSchema: z.ZodType<TripReminderStatus> = z.strictObject({
  enabled: z.boolean(),
  state: z.enum(['off', 'on', 'needs', 'unavailable']),
  missing: z.array(z.enum(['motion', 'notifications', 'locationAlways', 'locationPrecise'])),
});

export const reminderLocationSchema: z.ZodType<ReminderLocationAnswer> = z.enum(['always', 'whenInUse', 'denied', 'notNeeded']);

/** A reminder note's token: native makes it a UUID; anything else never crosses the bridge. */
export const REMINDER_TOKEN = /^[A-Za-z0-9-]{1,64}$/;

export const reminderTapSchema: z.ZodType<ReminderTap | null> = z
  .strictObject({ token: z.string().regex(REMINDER_TOKEN), at: z.number().finite().positive() })
  .nullable();
