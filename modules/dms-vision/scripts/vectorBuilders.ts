// The golden-vector builders. `make-vectors.ts` writes what these return, and
// `__tests__/vectors.test.ts` checks the committed files are a fresh generation. Every vector's
// `expected` is what the TS reference computes from its `inputs`, except onnx-parity, whose expected
// outputs come from Python onnxruntime 1.30.0 (`make-onnx-vectors.py`). Each builder runs under a
// margin probe, and a comparison closer than MARGIN_MIN to its threshold throws.
import { GazeInputAssembler } from '../src/reference/gazeInputs';
import { matrixFromPose } from '../src/reference/headPose';
import type { Rotation } from '../src/reference/landmarks';
import { MARGIN_MIN, setMarginProbe } from '../src/reference/probe';
import {
  bytesToBase64,
  runGazeInputsVector,
  runHeadPoseVector,
  runRecordVector,
  runStatsTrackerVector,
  type GoldenVector,
  type RecordFrame,
  type VectorImage,
} from '../src/reference/vectors';
import { DEFAULT_FACE, bufferLandmarks, faceLandmarks, renderBuffer, rng, type FaceParams, type ImageOptions } from './synth';

/**
 * The shortest decimal that parses back to the same float32 as `x`. The native side receives these
 * values as float32 (MediaPipe landmarks, ORT tensors), so a vector carries no more digits than that.
 * The reference runs on the parsed double, which differs from the float32 by < 1e-7 relative, far
 * inside the self-test tolerance and the probe margins.
 */
function short32(x: number): number {
  const target = Math.fround(x);
  for (let p = 6; p <= 9; p++) {
    const v = Number(target.toPrecision(p));
    if (Math.fround(v) === target) return v;
  }
  return target;
}

const f32 = (xs: ArrayLike<number>): number[] => Array.from(xs, short32);

/** A week of uptime (the float32 trap of Task 1 review C1), plus a fraction. */
const T0 = 6.048e8 + 0.375;
const EPOCH0 = 1_790_000_000_000;

function withProbe<T>(name: string, build: () => T): T {
  setMarginProbe((what, value, threshold) => {
    const margin = MARGIN_MIN * Math.max(1, Math.abs(threshold));
    if (Math.abs(value - threshold) < margin) {
      throw new Error(`vector ${name}: ${what} = ${value} is within ${margin} of ${threshold}`);
    }
  });
  try {
    return build();
  } finally {
    setMarginProbe(null);
  }
}

function face(over: Partial<FaceParams>): FaceParams {
  return { ...DEFAULT_FACE, w: 80, h: 100, fx: 40.3, fy: 48.9, a: 24.3, ...over };
}

class RecordBuilder {
  images: VectorImage[] = [];
  frames: RecordFrame[] = [];
  private t = T0;

  image(p: FaceParams, rotation: Rotation, format: 'bgra' | 'rgba', opts: ImageOptions = {}): number {
    const img = renderBuffer(p, rotation, format, opts);
    this.images.push({ w: img.w, h: img.h, format, pixels: bytesToBase64(img.bytes) });
    return this.images.length - 1;
  }

  frame(
    image: number,
    rotation: Rotation,
    p: FaceParams | null,
    pose: [number, number, number] | null,
    netGaze: [number, number, number] | null = null
  ): void {
    this.frames.push({
      tMs: this.t,
      image,
      rotationDeg: rotation,
      landmarks: p === null ? null : f32(bufferLandmarks(p, rotation)),
      matrix: pose === null ? null : f32(matrixFromPose(pose[0], pose[1], pose[2], rotation)),
      netGaze: netGaze === null ? null : f32(netGaze),
      latLandmarkMs: 11.25,
      latTotalMs: 17.5,
    });
    this.t += 1000 / 15;
  }

  vector(name: string, description: string): GoldenVector {
    const inputs = { anchorEpochMs: EPOCH0, images: this.images, frames: this.frames };
    return { name, description, kind: 'record', inputs, expected: { records: runRecordVector(inputs) } };
  }
}

function recordTracked(): GoldenVector {
  const b = new RecordBuilder();
  const p = face({ seed: 11 });
  const img = b.image(p, 90, 'bgra');
  b.frame(img, 90, p, [5, -3, 2]);
  b.frame(img, 90, face({ seed: 11, irisR: [0.12, 0.05], irisL: [0.1, 0.06] }), [8, -1, 1]);
  // A unit gaze vector in the model's stored convention: yaw ≈ 14°, pitch ≈ −8°.
  b.frame(img, 90, p, [5, -3, 2], [0.2393, 0.1392, 0.9609]);
  return b.vector('record-tracked-bgra-90', 'iOS pixels (BGRA), portrait (90°), a week of uptime: two tracked frames and one with the net');
}

function recordRotations(): GoldenVector {
  const b = new RecordBuilder();
  for (const [rot, seed] of [
    [0, 21],
    [180, 22],
    [270, 23],
  ] as const) {
    const p = face({ seed, irisR: [0.08, -0.03], irisL: [0.07, -0.02] });
    b.frame(b.image(p, rot, 'bgra'), rot, p, [20, 10, -4]);
  }
  return b.vector('record-rotations', 'the same pose at 0°, 180° and 270° buffer rotation: upright geometry and head pose must agree');
}

function recordAndroid(): GoldenVector {
  const b = new RecordBuilder();
  const p = face({ seed: 31 });
  b.frame(b.image(p, 270, 'rgba'), 270, p, [-12, 4, 3]);
  b.frame(b.image(p, 270, 'rgba', { noFace: true }), 270, null, null);
  return b.vector('record-android-rgba-270', 'Android pixels (RGBA) at 270°: a tracked frame, then a face-absent frame');
}

function recordClipped(): GoldenVector {
  const b = new RecordBuilder();
  // The face shifted right until the left eye (image right) leaves the frame.
  const right = face({ seed: 41, fx: 66.2 });
  b.frame(b.image(right, 90, 'bgra'), 90, right, [3, 0, 0]);
  // The face low enough for the mouth to leave the frame; no transformation matrix.
  const low = face({ seed: 42, fy: 86.2 });
  b.frame(b.image(low, 90, 'bgra'), 90, low, null);
  return b.vector('record-clipped', 'a clipped left eye; then a clipped mouth with POSE_MISSING');
}

function recordQuality(): GoldenVector {
  const b = new RecordBuilder();
  const p = face({ seed: 51 });
  b.frame(b.image(p, 90, 'bgra', { sunglasses: true }), 90, p, [0, -2, 0]);
  b.frame(b.image(p, 90, 'bgra', { glareR: true }), 90, p, [0, -2, 0]);
  const closed = face({ seed: 52, openR: 0.05, openL: 0.05, irisR: [0.02, 0.07], irisL: [0.03, 0.07] });
  b.frame(b.image(closed, 90, 'bgra'), 90, closed, [0, -18, 0]);
  const dark = face({ seed: 53 });
  b.frame(b.image(dark, 90, 'bgra', { gain: 0.15 }), 90, dark, [0, -2, 0]);
  b.frame(b.image(dark, 90, 'bgra', { gain: 0.1, noFace: true }), 90, null, null);
  return b.vector('record-quality', 'sunglasses, glare on the right eye, closed eyes looking down, low light, and a dark empty frame');
}

function gazeInputs(): GoldenVector {
  const frames = [0, 1, 2, 3].map((k) => {
    const p = face({
      w: 480,
      h: 640,
      fx: 241.3 + 7 * k,
      fy: 318.1,
      a: 121.7,
      seed: 61 + k,
      openR: k === 3 ? 0.04 : 0.32,
      openL: k === 3 ? 0.04 : 0.3,
    });
    return { tSec: 1234.5 + k / 15, landmarks: f32(faceLandmarks(p)) };
  });
  const inputs = { width: 480, height: 640, focalScale: 0.85, frames };
  return {
    name: 'gaze-inputs',
    description: 'the gaze network inputs for 4 frames (the last with closed eyes, not admitted to the tracker)',
    kind: 'gazeInputs',
    inputs,
    expected: { frames: runGazeInputsVector(inputs) },
  };
}

function statsTracker(v1: { training_mean: number[]; warmup: number; window_s: number; t: number[]; pushes: (number | null)[][] }): GoldenVector {
  const inputs = { trainingMean: v1.training_mean, warmup: v1.warmup, windowS: v1.window_s, t: v1.t, pushes: v1.pushes };
  return {
    name: 'stats-tracker',
    description: 'the subject-statistic tracker over the V1 reference fixture\'s 400 synthetic pushes (warm-up, forgetting, NaN rows)',
    kind: 'statsTracker',
    inputs,
    expected: { current: runStatsTrackerVector(inputs) },
  };
}

function headPose(): GoldenVector {
  const r = rng(71);
  const cases: { matrix: number[]; rotationDeg: Rotation }[] = [];
  const rotations: Rotation[] = [0, 90, 180, 270];
  for (let k = 0; k < 16; k++) {
    const yaw = (r() - 0.5) * 100;
    const pitch = (r() - 0.5) * 70;
    const roll = (r() - 0.5) * 50;
    const rot = rotations[k % 4]!;
    cases.push({ matrix: f32(matrixFromPose(yaw, pitch, roll, rot)), rotationDeg: rot });
  }
  const inputs = { cases };
  return {
    name: 'head-pose',
    description: 'facial transformation matrices built from known yaw/pitch/roll at every rotation',
    kind: 'headPose',
    inputs,
    expected: { poses: runHeadPoseVector(inputs) },
  };
}

/** The ONNX inputs (the expected outputs are filled by make-onnx-vectors.py). */
export function onnxInputs(): { cloud: number[]; context: number[]; validity: number[] }[] {
  const asm = new GazeInputAssembler();
  const out: { cloud: number[]; context: number[]; validity: number[] }[] = [];
  for (let k = 0; k < 8; k++) {
    const r = rng(81 + k);
    const p = face({
      w: 480,
      h: 640,
      fx: 180 + r() * 120,
      fy: 260 + r() * 120,
      a: 90 + r() * 50,
      seed: 81 + k,
      irisR: [(r() - 0.5) * 0.3, (r() - 0.5) * 0.2],
      irisL: [(r() - 0.5) * 0.3, (r() - 0.5) * 0.2],
    });
    const { inputs } = asm.prepare(f32(faceLandmarks(p)), 480, 640, 0.8 + r() * 0.3);
    out.push({ cloud: f32(inputs.cloud), context: f32(inputs.context), validity: Array.from(inputs.validity) });
  }
  return out;
}

export const VECTOR_NAMES = [
  'gaze-inputs',
  'head-pose',
  'onnx-parity',
  'record-android-rgba-270',
  'record-clipped',
  'record-quality',
  'record-rotations',
  'record-tracked-bgra-90',
  'stats-tracker',
] as const;

export type V1TrackerFixture = Parameters<typeof statsTracker>[0];

/** Every vector except onnx-parity (its outputs need Python). */
export function buildVectors(v1Tracker: V1TrackerFixture): Record<string, GoldenVector> {
  const list: [string, () => GoldenVector][] = [
    ['gaze-inputs', gazeInputs],
    ['head-pose', headPose],
    ['record-android-rgba-270', recordAndroid],
    ['record-clipped', recordClipped],
    ['record-quality', recordQuality],
    ['record-rotations', recordRotations],
    ['record-tracked-bgra-90', recordTracked],
    ['stats-tracker', () => statsTracker(v1Tracker)],
  ];
  return Object.fromEntries(list.map(([n, b]) => [n, withProbe(n, b)]));
}

export function serializeVector(v: unknown): string {
  return `${JSON.stringify(v)}\n`;
}
