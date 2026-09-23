// The DmsVision contract: what the Swift and Kotlin modules implement and what the DMS host
// (src/core/dms/host) consumes. README.md is the prose version; this file and constants.ts are the
// binding ones.
import type { DmsFps, Rotation, ThermalLevel, ThermalName } from './constants';

/**
 * `start(options)`. `gateToken` is minted only by the DMS policy's `gateOpen()` (plan rev1: S-M1);
 * native refuses a start without one and registers it for the session.
 */
export interface StartOptions {
  gateToken: string;
  fps: DmsFps;
  /** Run `gaze_direct` if this build has it (`DMS_GAZE_NET=1`). Not an error on a build without it. */
  gazeNet: boolean;
  /** Run the net on every frame (1) or every other frame (2) (plan rev1: m11). */
  gazeNetEvery: 1 | 2;
  delegate: 'cpu' | 'gpu';
  /** Added to the automatic buffer → upright rotation. 0 unless the orientation harness says so. */
  rotationOffsetDegrees: Rotation;
}

/** `setPolicy(policy)` — also the heartbeat. The token must equal the one `start` registered. */
export interface CapturePolicy {
  gateToken: string;
  capture: 'run' | 'pause';
  fps: DmsFps;
  gazeNet: boolean;
  gazeNetEvery: 1 | 2;
  /** C2 setup mode; the preview attaches only while this and `previewAllowed` are both true. */
  setupMode: boolean;
  previewAllowed: boolean;
}

export interface PermissionResult {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
}

export type NativeState = 'stopped' | 'starting' | 'running' | 'paused';

export type StateReason =
  | 'user'
  | 'policy'
  | 'background'
  | 'interrupted'
  | 'thermal'
  | 'watchdog'
  | 'error'
  | 'permission'
  | 'released';

export interface StateEvent {
  state: NativeState;
  reason: StateReason;
}

/** Once per second while running or paused, and from `getStatus()`. */
export interface NativeStatus {
  state: NativeState;
  /** The rate native is driving now: the policy's, capped by the thermal floor; 0 while not running. */
  fpsTarget: number;
  /** Records produced in the last second. */
  fpsActual: number;
  /** Frames dropped in the last second (one-in-flight rule, conversion failures). */
  dropped: number;
  gazeNetAvailable: boolean;
  gazeNetOn: boolean;
  thermal: ThermalName;
  /** The floor level in force, after the dwells. */
  thermalLevel: ThermalLevel;
  lowPower: boolean;
  latLandmarkP50: number | null;
  latLandmarkP95: number | null;
  /** null while the net is not running. */
  latGazeP50: number | null;
  latGazeP95: number | null;
  latTotalP50: number | null;
  latTotalP95: number | null;
  /** Process CPU milliseconds per second of wall time (plan rev1: I8); null before a full second. */
  procCpuMsPerS: number | null;
}

export interface ModelInfo {
  landmarkerSha256: string;
  gazeNetAvailable: boolean;
  /** null on a build without the net. */
  gazeSha256: string | null;
  mediapipe: '0.10.35';
  /** null on a build without the net. */
  onnxruntime: '1.30.0' | null;
}

export type DmsVisionEvents = {
  /** A raw frame batch as native emitted it — decode with `decodeFrameBatch` before use. */
  frames: unknown;
  status: NativeStatus;
  state: StateEvent;
};

export type DmsVisionEvent = keyof DmsVisionEvents;

export interface Subscription {
  remove(): void;
}

export interface DmsVisionApi {
  /** True when the native module is linked into this binary (a JS-only check). */
  isAvailable(): boolean;
  getPermission(): Promise<PermissionResult>;
  requestPermission(): Promise<PermissionResult>;
  start(options: StartOptions): Promise<void>;
  setPolicy(policy: CapturePolicy): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<NativeStatus>;
  getModelInfo(): Promise<ModelInfo>;
  selfTest(vectorsJson: string): Promise<string>;
  addListener<E extends DmsVisionEvent>(event: E, fn: (payload: DmsVisionEvents[E]) => void): Subscription;
}

/**
 * The event names both native modules declare, byte-identical to their `Events(...)` lists (the
 * native text tests compare them).
 */
export const DMS_VISION_EVENTS = ['frames', 'status', 'state'] as const;

/** Every bridged method (`AsyncFunction("<name>")` on both platforms), in declaration order. */
export const DMS_VISION_METHODS = [
  'getPermission',
  'requestPermission',
  'start',
  'setPolicy',
  'stop',
  'getStatus',
  'getModelInfo',
  'selfTest',
] as const;

export type DmsVisionMethod = (typeof DMS_VISION_METHODS)[number];

/** The codes a native method may reject with (README §2 "Errors"). Anything else is a bug. */
export const DMS_VISION_ERROR_CODES = [
  'E_UNAVAILABLE',
  'E_PERMISSION',
  'E_NOT_FOREGROUND',
  'E_BAD_ARGS',
  'E_CAMERA',
  'E_MODEL',
  'E_STATE',
] as const;

export type DmsVisionErrorCode = (typeof DMS_VISION_ERROR_CODES)[number];

/** Whether `e` is a DmsVision rejection (with `code`, when given). */
export function isDmsVisionError(e: unknown, code?: DmsVisionErrorCode): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return (
    typeof c === 'string' &&
    (DMS_VISION_ERROR_CODES as readonly string[]).includes(c) &&
    (code === undefined || c === code)
  );
}

/** An Error carrying a DmsVision `code`, as an Expo `CodedError` does. */
export function dmsVisionError(code: DmsVisionErrorCode, message: string): Error & { code: DmsVisionErrorCode } {
  return Object.assign(new Error(message), { code });
}
