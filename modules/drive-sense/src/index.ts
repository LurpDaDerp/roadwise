// The typed JS face of the native drive-sense module. README.md is the full contract.
//
// Arguments are checked before they cross the bridge and results are validated after, so a native
// bug surfaces as a rejected promise naming the method rather than as a malformed value deep in
// the drive host. `row` payloads are passed through untouched: the host validates each one with
// `parseRow` (it is the hot path, and a bad row is dropped, not thrown).
//
// The lookup is `requireOptionalNativeModule`, so importing this file never throws where the
// native module does not exist (Jest, Expo Go, web): every method rejects instead, and tests
// inject `createFakeDriveSense()`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { z } from 'zod';
import {
  captureModeSchema,
  captureRateSchema,
  driveDisplaySchema,
  exitInfoSchema,
  motionPermissionSchema,
  REMINDER_TOKEN,
  reminderLocationSchema,
  reminderTapSchema,
  screenStateSchema,
  stateSchema,
  thermalLevelSchema,
  tripReminderStatusSchema,
} from './rowSchema';
import type { DriveSenseApi, DriveSenseEvent, DriveSenseEvents, Subscription } from './types';

export * from './types';
export { CALL_ROW_KEY, MOCK_ROW_KEY, parseActivity, parseRow, REMINDER_TOKEN, resetUnknownRowKeys, unknownRowKeys } from './rowSchema';
export { createFakeDriveSense, driveSenseError } from './fake';
export type { FakeOptions } from './fake';
export { diffSelfTest, parseVectors } from './selfTest';
export type { SelfTestDiff, VectorDiff, Mismatch } from './selfTest';
export { extractSecond, initialExtractState } from './extract/extract';
export { gravityFilter, initialGravityState, androidAccelToReference } from './extract/gravityFilter';
export { runSelfTest, runVector } from './extract/vectors';
export { REMINDER } from './reminder/policy';
export {
  diffReminderSelfTest,
  matchReminderRow,
  referenceReminderOutput,
  reminderRowRunsOn,
  reminderWireVectors,
  runReminderRow,
} from './reminder/selfTest';
export type { ReminderActual, ReminderWireVector } from './reminder/selfTest';
export type { ReminderVector } from './reminder/vectors';
export type {
  ExtractVector,
  GravityVector,
  GoldenVector,
  SelfTestOutput,
  SelfTestResult,
} from './extract/vectors';
export type {
  ExtractState,
  FixSample,
  GravityState,
  ImuSample,
  PhoneSample,
  RawImuSample,
  Vec3,
} from './extract/types';

type NativeModule = {
  [K in Exclude<keyof DriveSenseApi, 'addListener'>]: (...args: never[]) => Promise<unknown>;
} & {
  addListener(event: string, fn: (payload: unknown) => void): Subscription;
};

const native = requireOptionalNativeModule<NativeModule>('DriveSense');

function bridge(): NativeModule {
  if (!native) {
    throw new Error('DriveSense native module is not available (Jest, Expo Go or web)');
  }
  return native;
}

const fail = (method: string, what: string): Error => new Error(`DriveSense.${method}: ${what}`);

/** Call `method` natively after checking its arguments, then validate the result. */
async function call<T>(
  method: Exclude<keyof DriveSenseApi, 'addListener'>,
  args: readonly unknown[],
  argsOk: boolean,
  result: z.ZodType<T>
): Promise<T> {
  if (!argsOk) throw fail(method, `invalid arguments ${safeJson(args)}`);
  const fn = bridge()[method] as (...a: readonly unknown[]) => Promise<unknown>;
  const raw = await fn(...args);
  const parsed = result.safeParse(raw);
  if (!parsed.success) throw fail(method, `invalid result ${safeJson(raw)}`);
  return parsed.data;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** `markLockProof` takes a delay up to a minute; native keeps it as a proof only at 15 s or less. */
const MARK_LOCK_PROOF_MAX_MS = 60_000;

const voidResult = z.union([z.undefined(), z.null()]).transform(() => undefined);
const ok = <S extends z.ZodType>(schema: S, v: unknown) => schema.safeParse(v).success;

const DriveSense: DriveSenseApi = {
  startCapture: (mode) => call('startCapture', [mode], ok(captureModeSchema, mode), voidResult),
  stopCapture: () => call('stopCapture', [], true, voidResult),
  setCaptureRate: (rate) =>
    call('setCaptureRate', [rate], ok(captureRateSchema, rate), voidResult),
  getState: () => call('getState', [], true, stateSchema),
  getScreenState: () => call('getScreenState', [], true, screenStateSchema),
  getThermalState: () => call('getThermalState', [], true, thermalLevelSchema),
  requestMotionPermission: () => call('requestMotionPermission', [], true, motionPermissionSchema),
  excludeFromBackup: (uri) =>
    call('excludeFromBackup', [uri], typeof uri === 'string' && uri.length > 0, voidResult),
  setDriveDisplay: (state) =>
    call('setDriveDisplay', [state], ok(driveDisplaySchema, state), voidResult),
  getLastExitInfo: () => call('getLastExitInfo', [], true, exitInfoSchema.nullable()),
  isIgnoringBatteryOptimizations: () =>
    call('isIgnoringBatteryOptimizations', [], true, z.boolean()),
  selfTest: (vectorsJson) =>
    call('selfTest', [vectorsJson], typeof vectorsJson === 'string', z.string()),
  setTripReminder: (enabled) =>
    call('setTripReminder', [enabled], typeof enabled === 'boolean', tripReminderStatusSchema),
  getTripReminderStatus: () => call('getTripReminderStatus', [], true, tripReminderStatusSchema),
  requestReminderLocation: () => call('requestReminderLocation', [], true, reminderLocationSchema),
  claimReminderTap: (token) =>
    call('claimReminderTap', [token], typeof token === 'string' && REMINDER_TOKEN.test(token), z.boolean()),
  takeReminderTap: () => call('takeReminderTap', [], true, reminderTapSchema),
  markLockProof: (delayMs) =>
    call('markLockProof', [delayMs], typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= MARK_LOCK_PROOF_MAX_MS, voidResult),
  addListener<E extends DriveSenseEvent>(
    event: E,
    fn: (payload: DriveSenseEvents[E]) => void
  ): Subscription {
    if (!native) return { remove() {} };
    // Payloads are the native module's; `row` stays `unknown` until `parseRow`.
    return native.addListener(event, fn as (payload: unknown) => void);
  },
};

export default DriveSense;
