// Bridge formats: the `frames` batch (decode + the encoder the fake, the tests and the vectors
// share) and the zod validators for every other payload native hands to JS.
//
// The frame record's NaN mask is enforced in BOTH directions (plan "Wire contract v1", rev1: I9):
// a field is NaN exactly when its mask class says it is not computed, so native can neither leak a
// stale value into a not-computed slot nor send a hole where a value is due. A record that breaks
// any rule is dropped and counted; the rest of its batch is kept. Only a broken header drops a batch.
import { z } from 'zod';
import {
  ALLOWED_FPS,
  ALLOWED_ROTATIONS,
  FLAG,
  FLAGS_ALL,
  FRAME_BYTES,
  FRAME_FIELDS,
  FRAME_MASK,
  FRAME_STRIDE,
  FRAME_WIRE_VERSION,
  type FrameField,
  type Rotation,
} from './constants';
import type { CapturePolicy, ModelInfo, NativeStatus, PermissionResult, StartOptions, StateEvent } from './types';

/** One decoded record. Not-computed fields are `null`. */
export interface FrameFeatures {
  tMs: number;
  face: boolean;
  boxCx: number | null;
  boxCy: number | null;
  boxW: number | null;
  boxH: number | null;
  iod: number | null;
  headYaw: number | null;
  headPitch: number | null;
  headRoll: number | null;
  netYaw: number | null;
  netPitch: number | null;
  earR: number | null;
  earL: number | null;
  eyeWR: number | null;
  eyeWL: number | null;
  eyeLumaR: number | null;
  eyeLumaL: number | null;
  irisContrastR: number | null;
  irisContrastL: number | null;
  eyeSatR: number | null;
  eyeSatL: number | null;
  irisOxR: number | null;
  irisOyR: number | null;
  irisOxL: number | null;
  irisOyL: number | null;
  irisInR: number | null;
  irisInL: number | null;
  faceLuma: number | null;
  blur: number | null;
  mar: number | null;
  mouthW: number | null;
  frameLuma: number;
  rotationDeg: Rotation;
  latLandmarkMs: number;
  latTotalMs: number;
  flags: number;
}

export interface FrameBatch {
  anchorTMs: number;
  anchorEpochMs: number;
  frames: FrameFeatures[];
}

export interface DecodeResult {
  /** null only when the header was broken. */
  batch: FrameBatch | null;
  droppedBatch: boolean;
  droppedRecords: number;
  /** The last accepted `tMs` (pass it to the next call to keep records monotonic across batches). */
  lastTMs: number | null;
}

/** A record as 38 numbers in `FRAME_FIELDS` order (NaN = not computed). */
export type RawRecord = readonly number[];

const HEADER_KEYS = ['anchorEpochMs', 'anchorTMs', 'data', 'n', 'v'];
const I = Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, i])) as Record<FrameField, number>;

/** Encode records as little-endian float32 (what native's `RecordEncoder` produces). */
export function encodeFrameBatch(records: readonly RawRecord[]): Uint8Array {
  const out = new Uint8Array(records.length * FRAME_BYTES);
  const view = new DataView(out.buffer);
  records.forEach((r, k) => {
    if (r.length !== FRAME_STRIDE) throw new RangeError(`a record has ${FRAME_STRIDE} fields, got ${r.length}`);
    for (let i = 0; i < FRAME_STRIDE; i++) view.setFloat32(k * FRAME_BYTES + i * 4, r[i]!, true);
  });
  return out;
}

/** The record native emits for a processed frame with no face (flags 0, every masked field NaN). */
export function faceAbsentRecord(
  tMs: number,
  frameLuma: number,
  rotationDeg: Rotation,
  latLandmarkMs: number,
  latTotalMs: number
): number[] {
  const r = FRAME_MASK.map((cls) => (cls === 'A' ? 0 : NaN));
  r[I.tMs] = tMs;
  r[I.face] = 0;
  r[I.frameLuma] = frameLuma;
  r[I.rotationDeg] = rotationDeg;
  r[I.latLandmarkMs] = latLandmarkMs;
  r[I.latTotalMs] = latTotalMs;
  r[I.flags] = 0;
  r[I.reserved] = 0;
  return r;
}

/** The raw record for decoded features (null → NaN, face → 0/1, reserved 0). */
export function recordFromFeatures(f: FrameFeatures): number[] {
  return FRAME_FIELDS.map((name) => {
    if (name === 'reserved') return 0;
    if (name === 'face') return f.face ? 1 : 0;
    const v = f[name];
    return v === null ? NaN : v;
  });
}

function isInt(v: number): boolean {
  return Number.isInteger(v);
}

/** Whether mask class `cls` requires NaN for this record. */
function nanRequired(cls: (typeof FRAME_MASK)[number], face: boolean, flags: number): boolean {
  switch (cls) {
    case 'A':
      return false;
    case 'F':
      return !face;
    case 'P':
      return !face || (flags & FLAG.POSE_MISSING) !== 0;
    case 'N':
      return (flags & FLAG.NET_RAN) === 0;
    case 'R':
      return !face || (flags & FLAG.EYE_CLIPPED_R) !== 0;
    case 'L':
      return !face || (flags & FLAG.EYE_CLIPPED_L) !== 0;
    case 'M':
      return !face || (flags & FLAG.MOUTH_CLIPPED) !== 0;
  }
}

/** Validate one record read from the wire. Returns the decoded features, or null to drop it. */
function decodeRecord(v: readonly number[]): FrameFeatures | null {
  for (const x of v) if (!Number.isNaN(x) && !Number.isFinite(x)) return null; // ±Infinity
  const faceRaw = v[I.face]!;
  const flags = v[I.flags]!;
  if (faceRaw !== 0 && faceRaw !== 1) return null;
  const face = faceRaw === 1;
  if (!isInt(flags) || flags < 0 || flags > FLAGS_ALL) return null;
  if (!face && flags !== 0) return null;
  for (let i = 0; i < FRAME_STRIDE; i++) {
    if (Number.isNaN(v[i]!) !== nanRequired(FRAME_MASK[i]!, face, flags)) return null;
  }
  if (v[I.reserved] !== 0) return null;
  if (!(ALLOWED_ROTATIONS as readonly number[]).includes(v[I.rotationDeg]!)) return null;
  if (v[I.tMs]! < 0 || v[I.latLandmarkMs]! < 0 || v[I.latTotalMs]! < 0) return null;
  if (v[I.frameLuma]! < 0 || v[I.frameLuma]! > 255) return null;
  if (face) {
    const rIn = v[I.irisInR]!;
    const lIn = v[I.irisInL]!;
    if ((rIn !== 0 && rIn !== 1) || (lIn !== 0 && lIn !== 1)) return null;
    if ((flags & FLAG.EYE_CLIPPED_R) !== 0 && rIn !== 0) return null;
    if ((flags & FLAG.EYE_CLIPPED_L) !== 0 && lIn !== 0) return null;
  }
  const out: Record<string, unknown> = {};
  FRAME_FIELDS.forEach((name, i) => {
    if (name === 'reserved') return;
    const x = v[i]!;
    out[name] = name === 'face' ? face : Number.isNaN(x) ? null : x;
  });
  return out as unknown as FrameFeatures;
}

/**
 * Decode one `frames` event. `prevTMs` is the last accepted `tMs` from the previous batch; a record
 * earlier than the last accepted one (in this batch or across batches) is dropped.
 */
export function decodeFrameBatch(raw: unknown, prevTMs: number | null = null): DecodeResult {
  const broken: DecodeResult = { batch: null, droppedBatch: true, droppedRecords: 0, lastTMs: prevTMs };
  if (typeof raw !== 'object' || raw === null) return broken;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== HEADER_KEYS.length || keys.some((k, i) => k !== HEADER_KEYS[i])) return broken;
  const { v, anchorTMs, anchorEpochMs, n, data } = o;
  if (v !== FRAME_WIRE_VERSION) return broken;
  if (typeof anchorTMs !== 'number' || !Number.isFinite(anchorTMs)) return broken;
  if (typeof anchorEpochMs !== 'number' || !Number.isFinite(anchorEpochMs)) return broken;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return broken;
  if (!(data instanceof Uint8Array) || data.byteLength !== n * FRAME_BYTES) return broken;

  // A view whose offset is not 4-aligned is copied so the reads below are plain and exact.
  const bytes = data.byteOffset % 4 === 0 ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: FrameFeatures[] = [];
  let dropped = 0;
  let last = prevTMs;
  const values = new Array<number>(FRAME_STRIDE);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < FRAME_STRIDE; i++) values[i] = view.getFloat32(k * FRAME_BYTES + i * 4, true);
    const f = decodeRecord(values);
    if (f === null || (last !== null && f.tMs < last)) {
      dropped++;
      continue;
    }
    last = f.tMs;
    frames.push(f);
  }
  return { batch: { anchorTMs, anchorEpochMs, frames }, droppedBatch: false, droppedRecords: dropped, lastTMs: last };
}

// ---------------------------------------------------------------------------------------------
// Validators for arguments (checked before the bridge) and results (checked after).
// ---------------------------------------------------------------------------------------------

const fps = z.union(ALLOWED_FPS.map((f) => z.literal(f)) as [z.ZodLiteral<5>, z.ZodLiteral<8>, z.ZodLiteral<10>, z.ZodLiteral<15>]);
const token = z.string().min(1);
const every = z.union([z.literal(1), z.literal(2)]);

export const startOptionsSchema: z.ZodType<StartOptions> = z.strictObject({
  gateToken: token,
  fps,
  gazeNet: z.boolean(),
  gazeNetEvery: every,
  delegate: z.enum(['cpu', 'gpu']),
  rotationOffsetDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

export const capturePolicySchema: z.ZodType<CapturePolicy> = z.strictObject({
  gateToken: token,
  capture: z.enum(['run', 'pause']),
  fps,
  gazeNet: z.boolean(),
  gazeNetEvery: every,
  setupMode: z.boolean(),
  previewAllowed: z.boolean(),
});

export const permissionSchema: z.ZodType<PermissionResult> = z.strictObject({
  status: z.enum(['granted', 'denied', 'undetermined']),
  canAskAgain: z.boolean(),
});

const nonNeg = z.number().nonnegative();
const latency = nonNeg.nullable();

export const nativeStateSchema = z.enum(['stopped', 'starting', 'running', 'paused']);

export const stateEventSchema: z.ZodType<StateEvent> = z.strictObject({
  state: nativeStateSchema,
  reason: z.enum(['user', 'policy', 'background', 'interrupted', 'thermal', 'watchdog', 'error', 'permission', 'released']),
});

export const statusSchema: z.ZodType<NativeStatus> = z
  .strictObject({
    state: nativeStateSchema,
    fpsTarget: nonNeg,
    fpsActual: nonNeg,
    dropped: z.number().int().nonnegative(),
    gazeNetAvailable: z.boolean(),
    gazeNetOn: z.boolean(),
    thermal: z.enum(['nominal', 'fair', 'serious', 'critical', 'unknown']),
    thermalLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    lowPower: z.boolean(),
    latLandmarkP50: latency,
    latLandmarkP95: latency,
    latGazeP50: latency,
    latGazeP95: latency,
    latTotalP50: latency,
    latTotalP95: latency,
    procCpuMsPerS: latency,
  })
  .refine((s) => s.gazeNetAvailable || !s.gazeNetOn, { message: 'the net cannot be on in a build without it' });

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const modelInfoSchema: z.ZodType<ModelInfo> = z
  .strictObject({
    landmarkerSha256: sha,
    gazeNetAvailable: z.boolean(),
    gazeSha256: sha.nullable(),
    mediapipe: z.literal('0.10.35'),
    onnxruntime: z.literal('1.30.0').nullable(),
  })
  .refine((m) => (m.gazeNetAvailable ? m.gazeSha256 !== null && m.onnxruntime !== null : m.gazeSha256 === null && m.onnxruntime === null), {
    message: 'the gaze net fields must match gazeNetAvailable',
  });

/** Parse a `status` event (null when malformed). */
export function parseStatus(raw: unknown): NativeStatus | null {
  const r = statusSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Parse a `state` event (null when malformed). */
export function parseStateEvent(raw: unknown): StateEvent | null {
  const r = stateEventSchema.safeParse(raw);
  return r.success ? r.data : null;
}
