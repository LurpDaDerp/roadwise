// The typed JS face of the iOS drive detector (`DriveDetect`, plan §3.1.1). Arguments are checked
// before they cross the bridge and results validated after, so a native bug surfaces as a rejected
// promise naming the method. Event payloads are validated too; one that fails is dropped and
// counted, never passed on.
//
// The lookup is `requireOptionalNativeModule`: on Android (the module is registered for Apple only),
// Jest, Expo Go and web `available` is false, every method but `wipe` rejects (a wipe resolves: there
// is nothing to wipe) and every listener is inert.
// Tests inject `createFakeDriveDetect()`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { z } from 'zod';

import { DETECT } from './detect/policy';
import {
  DETECT_REASONS,
  DRIVE_DETECT_ERROR_CODES,
  type DetectState,
  type DetectSubscription,
  type DriveDetectApi,
  type DriveDetectErrorCode,
  type DriveDetectEvent,
  type DriveDetectEvents,
  type DriveDetectMethod,
  type DriveEndedEvent,
  type DriveStartedEvent,
  type JournaledDrive,
  type ReadRowsResult,
  type StartWaitingResult,
} from './detect/types';

const epoch = z.number().int().nonnegative();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

/** A drive id: a lowercase UUID (the JS client_trip_id). */
export const DRIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const driveId = z.string().regex(DRIVE_ID);
/** An owner id: the signed-in user's id (a UUID), never empty. */
const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/;

const phase = z.enum(['off', 'armed', 'candidate', 'recording', 'ending', 'suppressed']);
const origin = z.enum(['auto', 'manual']);
const startSource = z.enum(['trace', 'motion', 'wake']);
const nativeCause = z.enum(['still', 'walking', 'limit', 'orphan', 'cancelled']);

const stateShape = {
  armed: z.boolean(),
  ownerId: z.string().regex(OWNER_ID).nullable(),
  state: phase,
  origin: origin.nullable(),
  driveId: driveId.nullable(),
  startedAt: epoch.nullable(),
  since: epoch,
  waitUntil: epoch.nullable(),
  lastEnd: z.strictObject({ decidedAt: epoch, cut: epoch, lat, lng, driveId }).nullable(),
  suppressedUntil: epoch.nullable(),
  status: z.enum(['on', 'needs', 'unavailable', 'off']),
  missing: z.array(z.enum(['locationAlways', 'locationPrecise', 'motion', 'backgroundRefresh', 'liveActivities'])),
  permissions: z.strictObject({
    location: z.enum(['none', 'whenInUse', 'always']),
    precise: z.boolean(),
    motion: z.enum(['granted', 'denied', 'undetermined', 'unavailable']),
    backgroundRefresh: z.enum(['available', 'denied', 'restricted']),
    liveActivities: z.boolean(),
    canAskAlways: z.boolean(),
  }),
  journalDropped: z.number().int().nonnegative(),
};

export const detectStateSchema: z.ZodType<DetectState> = z.strictObject(stateShape);
export const detectStateEventSchema: z.ZodType<DriveDetectEvents['detectState']> = z.strictObject({
  ...stateShape,
  reason: z.enum(DETECT_REASONS as [DriveDetectEvents['detectState']['reason'], ...DriveDetectEvents['detectState']['reason'][]]),
});

export const driveStartedSchema: z.ZodType<DriveStartedEvent> = z.strictObject({
  driveId,
  origin,
  startedAt: epoch,
  startSource,
  startLat: lat.nullable(),
  startLng: lng.nullable(),
  continues: z.boolean(),
  confirmedAt: epoch,
  firstSeq: z.number().int().min(1),
});

export const driveEndedSchema: z.ZodType<DriveEndedEvent> = z.strictObject({
  driveId,
  endedAt: epoch,
  cause: nativeCause,
  decidedAt: epoch,
  lastSeq: z.number().int().nonnegative(),
  lastRowTs: epoch.nullable(),
});

export const journaledDriveSchema: z.ZodType<JournaledDrive> = z.strictObject({
  driveId,
  origin,
  startedAt: epoch,
  startSource,
  startLat: lat.nullable(),
  startLng: lng.nullable(),
  continues: z.boolean(),
  confirmedAt: epoch,
  firstSeq: z.number().int().min(1),
  lastSeq: z.number().int().nonnegative(),
  lastRowTs: epoch.nullable(),
  bytes: z.number().int().nonnegative(),
  ended: z.strictObject({ endedAt: epoch, cause: z.enum(['still', 'walking', 'limit', 'orphan', 'cancelled', 'js']), decidedAt: epoch }).nullable(),
});

export const readRowsResultSchema: z.ZodType<ReadRowsResult> = z.strictObject({
  rows: z.array(z.unknown()).max(DETECT.READ_ROWS_MAX),
  lastSeq: z.number().int().nonnegative(),
  done: z.boolean(),
});

export const startWaitingResultSchema: z.ZodType<StartWaitingResult> = z.union([
  z.strictObject({ ok: z.literal(true), waitUntil: epoch }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['permission', 'busy', 'unavailable']) }),
]);

const alwaysAnswerSchema = z.enum(['always', 'whenInUse', 'denied']);
const voidResult = z.union([z.undefined(), z.null()]).transform(() => undefined);

const EVENT_SCHEMAS: { [E in DriveDetectEvent]: z.ZodType<DriveDetectEvents[E]> } = {
  detectState: detectStateEventSchema,
  driveStarted: driveStartedSchema,
  driveEnded: driveEndedSchema,
};

type NativeModule = { [K in DriveDetectMethod]: (...args: never[]) => Promise<unknown> } & {
  addListener(event: string, fn: (payload: unknown) => void): DetectSubscription;
};

const native = requireOptionalNativeModule<NativeModule>('DriveDetect');

let dropped = 0;
/** Event payloads dropped for failing validation since the last reset (diagnostics). */
export const droppedDetectEvents = (): number => dropped;
export function resetDroppedDetectEvents(): void {
  dropped = 0;
}

/** Whether `e` is a DriveDetect rejection with `code` (Expo `CodedError` carries `.code`). */
export function isDriveDetectError(e: unknown, code?: DriveDetectErrorCode): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && (DRIVE_DETECT_ERROR_CODES as readonly string[]).includes(c) && (code === undefined || c === code);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const fail = (method: string, what: string): Error => new Error(`DriveDetect.${method}: ${what}`);

async function call<T>(method: DriveDetectMethod, args: readonly unknown[], argsOk: boolean, result: z.ZodType<T>): Promise<T> {
  if (!argsOk) throw fail(method, `invalid arguments ${safeJson(args)}`);
  if (!native) throw fail(method, 'not available (Android, Jest, Expo Go or web)');
  const fn = native[method] as (...a: readonly unknown[]) => Promise<unknown>;
  const raw = await fn(...args);
  const parsed = result.safeParse(raw);
  if (!parsed.success) throw fail(method, `invalid result ${safeJson(raw)}`);
  return parsed.data;
}

const isDriveId = (v: unknown): v is string => typeof v === 'string' && DRIVE_ID.test(v);
const isCount = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export const DriveDetect: DriveDetectApi = {
  available: native !== null && native !== undefined,
  setArmed: (armed, ownerId) =>
    call('setArmed', [armed, ownerId], typeof armed === 'boolean' && typeof ownerId === 'string' && OWNER_ID.test(ownerId), detectStateSchema),
  getState: () => call('getState', [], true, detectStateSchema),
  requestAlways: () => call('requestAlways', [], true, alwaysAnswerSchema),
  startWaiting: () => call('startWaiting', [], true, startWaitingResultSchema),
  extendWaiting: () => call('extendWaiting', [], true, epoch.nullable()),
  cancelWaiting: () => call('cancelWaiting', [], true, voidResult),
  notDriving: () => call('notDriving', [], true, voidResult),
  listDrives: () => call('listDrives', [], true, z.array(journaledDriveSchema).max(DETECT.JOURNAL_MAX_DRIVES * 4)),
  readRows: (id, afterSeq, limit) =>
    call('readRows', [id, afterSeq, limit], isDriveId(id) && isCount(afterSeq, 0, Number.MAX_SAFE_INTEGER) && isCount(limit, 1, DETECT.READ_ROWS_MAX), readRowsResultSchema),
  discardDrive: (id) => call('discardDrive', [id], isDriveId(id), voidResult),
  // A wipe must never fail where there is no detector (Android, Jest, Expo Go, web): nothing to wipe.
  wipe: () => (native ? call('wipe', [], true, voidResult) : Promise.resolve()),
  addListener<E extends DriveDetectEvent>(event: E, fn: (p: DriveDetectEvents[E]) => void): DetectSubscription {
    if (!native) return { remove() {} };
    const schema = EVENT_SCHEMAS[event] as z.ZodType<DriveDetectEvents[E]>;
    return native.addListener(event, (raw) => {
      const parsed = schema.safeParse(raw);
      if (parsed.success) fn(parsed.data);
      else dropped += 1;
    });
  },
};

export default DriveDetect;
