// The typed JS face of the native DmsVision module. README.md is the full contract.
//
// Arguments are checked before they cross the bridge (a bad one rejects with E_BAD_ARGS and never
// reaches native), and results are validated after, so a native bug surfaces as a rejected promise
// naming the method. `frames`, `status` and `state` payloads are passed through untouched: the DMS
// host decodes them (`decodeFrameBatch`, `parseStatus`, `parseStateEvent`) on its own schedule.
//
// The lookup is `requireOptionalNativeModule`, so importing this file never throws where the native
// module does not exist (Jest, Expo Go, web): every method rejects with E_UNAVAILABLE instead
// (`stop` resolves), and tests inject `createFakeDmsVision()`.
//
// Only the DMS host controller (src/core/dms/host) and the dev diagnostics route may import this
// module (plan rev1: S-M1). The rule is to be enforced by the plan's Task 15 `imports.test.ts`.
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { z } from 'zod';
import {
  capturePolicySchema,
  modelInfoSchema,
  permissionSchema,
  startOptionsSchema,
  statusSchema,
} from './wire';
import {
  dmsVisionError,
  type DmsVisionApi,
  type DmsVisionEvent,
  type DmsVisionEvents,
  type DmsVisionMethod,
  type Subscription,
} from './types';

export * from './types';
export * from './constants';
export {
  buildFrameBatch,
  decodeFrameBatch,
  encodeFrameBatch,
  faceAbsentRecord,
  recordFromFeatures,
  parseStatus,
  parseStateEvent,
} from './wire';
export type { AbsoluteRecord, FrameFeatures, FrameBatch, DecodeResult, RawFrameBatch, RawRecord } from './wire';
export { createFakeDmsVision } from './fake';
export type { FakeDmsVision, FakeOptions } from './fake';

type NativeModule = {
  [K in DmsVisionMethod]: (...args: never[]) => Promise<unknown>;
} & {
  addListener(event: string, fn: (payload: unknown) => void): Subscription;
};

const native = requireOptionalNativeModule<NativeModule>('DmsVision');

const UNAVAILABLE = 'DmsVision native module is not available (Jest, Expo Go or web)';

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

type Parser<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } };

const voidResult: Parser<void> = {
  safeParse: (v) => (v === undefined || v === null ? { success: true, data: undefined } : { success: false }),
};
const stringResult: Parser<string> = {
  safeParse: (v) => (typeof v === 'string' ? { success: true, data: v } : { success: false }),
};

/** Call `method` natively after checking its arguments, then validate the result. */
async function call<T>(
  method: DmsVisionMethod,
  args: readonly unknown[],
  argsOk: boolean,
  result: Parser<T> | z.ZodType<T>
): Promise<T> {
  if (!native) throw dmsVisionError('E_UNAVAILABLE', UNAVAILABLE);
  if (!argsOk) throw dmsVisionError('E_BAD_ARGS', `DmsVision.${method}: invalid arguments ${safeJson(args)}`);
  const fn = native[method] as (...a: readonly unknown[]) => Promise<unknown>;
  const raw = await fn(...args);
  const parsed = (result as Parser<T>).safeParse(raw);
  if (!parsed.success) throw dmsVisionError('E_RESULT', `DmsVision.${method}: invalid result ${safeJson(raw)}`);
  return parsed.data;
}

const DmsVision: DmsVisionApi = {
  isAvailable: () => native !== null,
  getPermission: () => call('getPermission', [], true, permissionSchema),
  requestPermission: () => call('requestPermission', [], true, permissionSchema),
  start: (options) => call('start', [options], startOptionsSchema.safeParse(options).success, voidResult),
  setPolicy: (policy) => call('setPolicy', [policy], capturePolicySchema.safeParse(policy).success, voidResult),
  stop: async () => {
    if (!native) return;
    await call('stop', [], true, voidResult);
  },
  getStatus: () => call('getStatus', [], true, statusSchema),
  getModelInfo: () => call('getModelInfo', [], true, modelInfoSchema),
  selfTest: (vectorsJson) => call('selfTest', [vectorsJson], typeof vectorsJson === 'string', stringResult),
  addListener<E extends DmsVisionEvent>(event: E, fn: (payload: DmsVisionEvents[E]) => void): Subscription {
    if (!native) return { remove() {} };
    return native.addListener(event, fn as (payload: unknown) => void);
  },
};

export default DmsVision;
