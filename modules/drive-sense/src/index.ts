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
  audioOutputSchema,
  captureEndSchema,
  captureModeSchema,
  captureRateSchema,
  dashpalLinkResultSchema,
  dashpalLinkStateSchema,
  driveDisplaySchema,
  exitInfoSchema,
  INSTALLED_APPS_MAX,
  installedAppsSchema,
  motionPermissionSchema,
  PACKAGE_NAME,
  REMINDER_TOKEN,
  reminderLocationSchema,
  reminderTapSchema,
  screenStateSchema,
  stateSchema,
  thermalLevelSchema,
  tripReminderStatusSchema,
} from './rowSchema';
import { isNavAppPackage } from './navPackages';
import type { AudioOutputState, CaptureEnd, DriveSenseApi, DriveSenseEvent, DriveSenseEvents, DriveSenseSyncMethod, Subscription } from './types';

export * from './types';
export { CALL_ROW_KEY, MOCK_ROW_KEY, parseActivity, parseRow, parseSpeed, REMINDER_TOKEN, resetUnknownRowKeys, SEQ_ROW_KEY, unknownRowKeys } from './rowSchema';
export { createFakeDriveSense, driveSenseError } from './fake';
export type { FakeOptions } from './fake';
export { diffSelfTest, parseVectors } from './selfTest';
export type { SelfTestDiff, VectorDiff, Mismatch } from './selfTest';
export { extractSecond, initialExtractState } from './extract/extract';
export { gravityFilter, initialGravityState, androidAccelToReference } from './extract/gravityFilter';
export { runSelfTest, runVector } from './extract/vectors';
export { REMINDER } from './reminder/policy';
export { isNavAppPackage, NAV_APP_PACKAGES } from './navPackages';
// The iOS drive detector (plan §3.1.1): its bridge, fake, rules, decision table, self-test and journal format.
export {
  DriveDetect,
  DRIVE_ID,
  droppedDetectEvents,
  isDriveDetectError,
  resetDroppedDetectEvents,
} from './detect';
export * from './detect/types';
export { createFakeDriveDetect } from './fakeDetect';
export type { FakeConfirm, FakeDetectControls, FakeDetectOptions } from './fakeDetect';
export {
  AUTO_TRIGGER,
  autoHoldMs,
  candidateDue,
  CONFIRM_START,
  confirmStep,
  continuesFrom,
  DETECT,
  distanceM,
  endClockAt,
  endDue,
  endOnRow,
  MANUAL_TRIGGER,
  motionGate,
  moving,
  MPS_PER_MPH,
  recentStarts,
  resumeDecision,
  rolling,
  slow,
  startOf,
  startsAfter,
  statusOf,
  summarize,
  suppressionDue,
  traceStart,
  trusted,
  wakeGate,
} from './detect/policy';
export type {
  ActivitySample,
  CandidateCause,
  ConfirmState,
  DetectLastEnd,
  DetectRow,
  EndClock,
  LatLng,
  MotionGate,
  MotionSummary,
  SafetyCause,
  StatusInputs,
  TracedStart,
  TriggerKind,
  WakeCtx,
  WakeGate,
  WakeReason,
} from './detect/policy';
export { DETECT_VECTORS } from './detect/vectors';
export type { DetectVector } from './detect/vectors';
export {
  detectWireVectors,
  diffDetectSelfTest,
  matchDetectRow,
  referenceDetectOutput,
  runDetectRow,
} from './detect/selfTest';
export type { DetectActual, DetectWireVector } from './detect/selfTest';
export { journalLine, parseJournalLine, readJournal } from './detect/journal';
export type { JournalEnd, JournalGap, JournalLine, JournalRow, JournalStart, ReadJournal } from './detect/journal';
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

type AsyncMethod = Exclude<keyof DriveSenseApi, 'addListener' | DriveSenseSyncMethod>;

type NativeModule = {
  [K in AsyncMethod]: (...args: never[]) => Promise<unknown>;
} & {
  [K in DriveSenseSyncMethod]: (...args: never[]) => unknown;
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
  method: AsyncMethod,
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

/**
 * A sync bridge function (`Function`, not `AsyncFunction`): its arguments checked, its result
 * validated. Without the native module it answers `absent` (the unknown value) and never throws.
 */
function callSync<T>(method: DriveSenseSyncMethod, args: readonly unknown[], argsOk: boolean, result: z.ZodType<T>, absent: T): T {
  if (!argsOk) throw fail(method, `invalid arguments ${safeJson(args)}`);
  if (!native) return absent;
  const fn = native[method] as (...a: readonly unknown[]) => unknown;
  const raw = fn(...args);
  const parsed = result.safeParse(raw);
  if (!parsed.success) throw fail(method, `invalid result ${safeJson(raw)}`);
  return parsed.data;
}

/** `audioOutputState()` with nothing known: no call, volume and headphones unknown (it never blocks a sound). */
const AUDIO_UNKNOWN: AudioOutputState = { callActive: false, volume: null, headphones: null };

/** `holdAwake` takes up to 10 s (native clamps to 1-10 s as well). */
export const HOLD_AWAKE_MAX_MS = 10_000;

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** `markLockProof` takes a delay up to a minute; native keeps it as a proof only at 15 s or less. */
const MARK_LOCK_PROOF_MAX_MS = 60_000;

/** A well-formed package name that is one of the navigation apps (`navPackages.ts`). */
const isPackageName = (v: unknown): v is string => typeof v === 'string' && v.length <= 255 && PACKAGE_NAME.test(v) && isNavAppPackage(v);

/**
 * `stopCapture`'s native arguments (kind, endedAt, drivingAtEnd): "now" with nothing known,
 * "dropped" for a drive not kept, "at" with its driving end. Only a valid `end` is ever sent.
 */
function captureEndArgs(end: CaptureEnd | undefined): [string, number, boolean] {
  if (end === undefined || end === null || typeof end !== 'object') return ['now', 0, false];
  const atEnd = end.drivingAtEnd === true;
  return end.drivingEndedAt === null ? ['dropped', 0, atEnd] : ['at', end.drivingEndedAt, atEnd];
}

const voidResult = z.union([z.undefined(), z.null()]).transform(() => undefined);
const ok = <S extends z.ZodType>(schema: S, v: unknown) => schema.safeParse(v).success;

const DriveSense: DriveSenseApi = {
  startCapture: (mode) => call('startCapture', [mode], ok(captureModeSchema, mode), voidResult),
  stopCapture: (end) => call('stopCapture', captureEndArgs(end), end === undefined || ok(captureEndSchema, end), voidResult),
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
  listInstalledApps: (packages) =>
    call(
      'listInstalledApps',
      [Array.isArray(packages) ? [...packages] : packages],
      Array.isArray(packages) && packages.length > 0 && packages.length <= INSTALLED_APPS_MAX && packages.every(isPackageName),
      installedAppsSchema
    ),
  launchApp: (packageName) => call('launchApp', [packageName], isPackageName(packageName), z.boolean()),
  setDashpalLink: (state) => call('setDashpalLink', [state], ok(dashpalLinkStateSchema, state), dashpalLinkResultSchema),
  audioOutputState: () => ({ ...callSync('audioOutputState', [], true, audioOutputSchema, AUDIO_UNKNOWN) }),
  holdAwake: (ms) =>
    callSync('holdAwake', [ms], typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= HOLD_AWAKE_MAX_MS, z.boolean(), false),
  dashpalLinkRunning: () => callSync('dashpalLinkRunning', [], true, z.boolean(), false),
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
