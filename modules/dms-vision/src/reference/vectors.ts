// The golden-vector formats and the reference run over each (README §8). Native `selfTest` runs its
// PRODUCTION classes over the same inputs and returns the "native output" forms below. `selfTest.ts`
// diffs them against `expected`.
import { buildFrameBatch } from '../wire';
import { runBatcher, type BatcherFlush, type BatcherFrame } from './batcher';
import { focalScale, type SensorGeometry } from './focal';
import { GazeInputAssembler, SubjectStatisticTracker } from './gazeInputs';
import { geometry } from './features';
import { headPoseFromAnyLayout } from './headPose';
import { landmarksToUpright, type Rotation } from './landmarks';
import { lumaPlane, type PixelFormat } from './roi';
import { buildRecord } from './record';

/** JSON cannot carry NaN; `null` stands for it in vectors and outputs. */
export type Num = number | null;

export interface VectorImage {
  w: number;
  h: number;
  /** bytes per row, ≥ w·4 (camera rows are padded; Task 2 review I1) */
  stride: number;
  format: PixelFormat;
  /** base64 of `stride·h` bytes; the row padding is 0xFF in the padded vectors */
  pixels: string;
}

export interface RecordFrame {
  tMs: number;
  /** index into `images` */
  image: number;
  rotationDeg: Rotation;
  /** buffer-frame landmarks, 1434 numbers, or null (no face) */
  landmarks: number[] | null;
  /** column-major 4×4, buffer frame, or null */
  matrix: number[] | null;
  /** the net's output vector, or null (not run) */
  netGaze: number[] | null;
  latLandmarkMs: number;
  latTotalMs: number;
}

export type GoldenVector =
  | {
      name: string;
      description: string;
      kind: 'record';
      inputs: { anchorEpochMs: number; images: VectorImage[]; frames: RecordFrame[] };
      /** absolute-form records (field 0 = tMs), NaN as null */
      expected: { records: Num[][] };
    }
  | {
      name: string;
      description: string;
      kind: 'gazeInputs';
      inputs: { width: number; height: number; focalScale: number; frames: { tSec: number; landmarks: number[] }[] };
      expected: { frames: { cloud: number[]; context: number[]; validity: number[]; admitted: boolean }[] };
    }
  | {
      name: string;
      description: string;
      kind: 'statsTracker';
      inputs: { trainingMean: number[]; warmup: number; windowS: number; t: number[]; pushes: Num[][] };
      expected: { current: number[][] };
    }
  | {
      name: string;
      description: string;
      kind: 'headPose';
      inputs: { cases: { matrix: number[]; rotationDeg: Rotation }[] };
      /** null where the matrix layout is ambiguous (`normaliseMatrixLayout`) */
      expected: { poses: ([number, number, number] | null)[] };
    }
  | {
      name: string;
      description: string;
      kind: 'onnx';
      inputs: { cases: { cloud: number[]; context: number[]; validity: number[] }[] };
      /** from Python onnxruntime 1.30.0 (scripts/make-onnx-vectors.py) */
      expected: { cases: { gaze: number[]; rotation: number[] }[] };
    }
  | {
      name: string;
      description: string;
      kind: 'batcher';
      /** the wall clock read with a frame's `nowMs` is `nowMs + epochOffsetMs` */
      inputs: { cases: { intervalMs: number; epochOffsetMs: number; frames: BatcherFrame[] }[] };
      expected: { cases: { flushes: BatcherFlush[] }[] };
    }
  | {
      name: string;
      description: string;
      kind: 'focal';
      /** Android camera characteristics (null: the field-of-view fallback); iOS answers `skipped` */
      inputs: { cases: { sensor: SensorGeometry | null; width: number; height: number; rotationDeg: Rotation }[] };
      expected: { focalScales: number[] };
    };

export type VectorKind = GoldenVector['kind'];

export function base64ToBytes(b64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('invalid base64');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? alphabet[n & 63]! : '=';
  }
  return out;
}

export const nanToNull = (x: number): Num => (Number.isNaN(x) ? null : x);
export const nullToNan = (x: Num): number => (x === null ? NaN : x);

/** The reference records for a record vector (absolute form, NaN as null). */
export function runRecordVector(inputs: Extract<GoldenVector, { kind: 'record' }>['inputs']): Num[][] {
  const lumas = inputs.images.map((img) => lumaPlane(base64ToBytes(img.pixels), img.w, img.h, img.format, img.stride));
  return inputs.frames.map((f) => {
    const img = inputs.images[f.image]!;
    return buildRecord({
      tMs: f.tMs,
      bufferW: img.w,
      bufferH: img.h,
      rotationDeg: f.rotationDeg,
      luma: lumas[f.image]!,
      landmarks: f.landmarks,
      matrix: f.matrix,
      netGaze: f.netGaze,
      latLandmarkMs: f.latLandmarkMs,
      latTotalMs: f.latTotalMs,
    }).map(nanToNull);
  });
}

/** The native output shape for a record vector: the encoded batch of all its frames. */
export function recordBatchOutput(inputs: Extract<GoldenVector, { kind: 'record' }>['inputs']) {
  const records = runRecordVector(inputs).map((r) => r.map(nullToNan));
  const b = buildFrameBatch(records, inputs.anchorEpochMs);
  return { anchorTMs: b.anchorTMs, anchorEpochMs: b.anchorEpochMs, n: b.n, data: bytesToBase64(b.data) };
}

export function runGazeInputsVector(inputs: Extract<GoldenVector, { kind: 'gazeInputs' }>['inputs']) {
  const asm = new GazeInputAssembler();
  return inputs.frames.map((f) => {
    const { inputs: net, cloud64 } = asm.prepare(f.landmarks, inputs.width, inputs.height, inputs.focalScale);
    const g = geometry(f.landmarks, inputs.width, inputs.height);
    const admitted = asm.admit(cloud64, f.tSec, g.right?.ear ?? NaN, g.left?.ear ?? NaN, g.right === null, g.left === null);
    return { cloud: Array.from(net.cloud), context: Array.from(net.context), validity: Array.from(net.validity), admitted };
  });
}

export function runStatsTrackerVector(inputs: Extract<GoldenVector, { kind: 'statsTracker' }>['inputs']): number[][] {
  const tracker = new SubjectStatisticTracker(inputs.trainingMean, inputs.warmup, inputs.windowS);
  return inputs.pushes.map((p, i) => Array.from(tracker.push(p.map(nullToNan), inputs.t[i]!)));
}

export function runHeadPoseVector(inputs: Extract<GoldenVector, { kind: 'headPose' }>['inputs']): ([number, number, number] | null)[] {
  return inputs.cases.map((c) => {
    const p = headPoseFromAnyLayout(c.matrix, c.rotationDeg);
    return p === null ? null : [p.yawDeg, p.pitchDeg, p.rollDeg];
  });
}

export function runBatcherVector(inputs: Extract<GoldenVector, { kind: 'batcher' }>['inputs']): { flushes: BatcherFlush[] }[] {
  return inputs.cases.map((c) => ({ flushes: runBatcher(c.intervalMs, c.frames, c.epochOffsetMs) }));
}

export function runFocalVector(inputs: Extract<GoldenVector, { kind: 'focal' }>['inputs']): number[] {
  return inputs.cases.map((c) => focalScale(c.sensor, c.width, c.height, c.rotationDeg));
}

/** Upright landmarks of a record frame (for tests). */
export function uprightOf(f: RecordFrame): Float64Array | null {
  return f.landmarks === null ? null : landmarksToUpright(f.landmarks, f.rotationDeg);
}
