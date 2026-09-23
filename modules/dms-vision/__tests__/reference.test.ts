/** @jest-environment node */
// The TS reference of the native maths. Each part is pinned by something that did NOT come from the
// reference itself:
// - the V1 Python reference's own synthetic fixtures (gaze inputs, EAR, the statistic tracker);
// - hand-built geometry (the iris-offset oracle, polygons, EAR on a known shape);
// - rotation matrices built from known angles (head pose).
import { FLAG, FRAME_FIELDS, type FrameField } from '../src/constants';
import { geometry, insidePolygon } from '../src/reference/features';
import {
  GazeInputAssembler,
  SubjectStatisticTracker,
  cameraContext,
  eyeAspectRatiosOnCloud,
  eyeCenterAndIod,
  landmarkValidity,
  rowStatistics,
  weak3dCloud,
} from '../src/reference/gazeInputs';
import { gazeAngles, headPoseFromMatrix, matrixFromPose } from '../src/reference/headPose';
import { irisOffset } from '../src/reference/irisOffset';
import { LANDMARK_FLOATS, landmarksToBuffer, landmarksToUpright, uprightSize, type Rotation } from '../src/reference/landmarks';
import { blurScore, eyeLuma, faceLuma, frameLuma, luma601, lumaPlane } from '../src/reference/roi';
import { buildRecord } from '../src/reference/record';
import { buildFrameBatch, decodeFrameBatch } from '../src/wire';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const fixture = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'v1-reference', name), 'utf8')) as T;

const I = Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, i])) as Record<FrameField, number>;

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number | null>, tol: number) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    if (e === null) expect(Number.isNaN(actual[i]!)).toBe(true);
    else expect(Math.abs(actual[i]! - e!)).toBeLessThanOrEqual(tol);
  }
}

describe('V1 Python-reference parity (synthetic fixtures)', () => {
  type Case = {
    landmarks: number[][];
    width: number;
    height: number;
    focal_scale: number;
    cloud: number[];
    context3: number[];
    validity: number[];
    row_statistics: number[];
    eye_aspect_ratios: (number | null)[];
    eye_center: number[];
    iod: number;
  };
  const cases = fixture<{ cases: Case[] }>('gaze_inputs_cases.json').cases;

  test('20 cases, from the reference generator', () => expect(cases).toHaveLength(20));

  test.each(cases.map((c, i) => [i, c] as const))('case %i: cloud, context, validity, statistics, EAR, eye centre', (_i, c) => {
    const flat = c.landmarks.flat();
    expectClose(weak3dCloud(flat, c.width, c.height), c.cloud, 1e-9);
    expectClose(cameraContext(flat, c.width, c.height, c.focal_scale), c.context3, 1e-9);
    expectClose(landmarkValidity(flat), c.validity, 0);
    expectClose(rowStatistics(weak3dCloud(flat, c.width, c.height)), c.row_statistics, 1e-9);
    expectClose(eyeAspectRatiosOnCloud(weak3dCloud(flat, c.width, c.height)), c.eye_aspect_ratios, 1e-9);
    const { center, iod } = eyeCenterAndIod(flat, c.width, c.height);
    expectClose(center, c.eye_center, 1e-12);
    expect(Math.abs(iod - c.iod)).toBeLessThanOrEqual(1e-12);
  });

  test('the pixel-space EAR of the feature pass equals the reference EAR (it is scale- and translation-invariant)', () => {
    let compared = 0;
    for (const c of cases) {
      const g = geometry(c.landmarks.flat(), c.width, c.height);
      if (g.right && c.eye_aspect_ratios[0] !== null) {
        expect(Math.abs(g.right.ear - c.eye_aspect_ratios[0]!)).toBeLessThanOrEqual(1e-9);
        compared++;
      }
      if (g.left && c.eye_aspect_ratios[1] !== null) {
        expect(Math.abs(g.left.ear - c.eye_aspect_ratios[1]!)).toBeLessThanOrEqual(1e-9);
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(28); // most eyes are unclipped in the 20 cases
  });

  test('the subject-statistic tracker reproduces the reference over 400 pushes', () => {
    const f = fixture<{ training_mean: number[]; warmup: number; window_s: number; t: number[]; pushes: (number | null)[][]; current: number[][] }>(
      'gaze_inputs_stats_tracker.json'
    );
    const tracker = new SubjectStatisticTracker(f.training_mean, f.warmup, f.window_s);
    f.pushes.forEach((p, i) => {
      const cur = tracker.push(p.map((x) => (x === null ? NaN : x)), f.t[i]!);
      expectClose(cur, f.current[i]!, 1e-12);
    });
  });
});

describe('landmark transforms', () => {
  test.each([0, 90, 180, 270] as Rotation[])('buffer → upright → buffer is the identity at %i°', (rot) => {
    const lm = Float64Array.from({ length: LANDMARK_FLOATS }, (_, i) => ((i * 7919) % 1000) / 1000);
    const back = landmarksToBuffer(landmarksToUpright(lm, rot), rot);
    expectClose(back, Array.from(lm), 1e-15);
  });
  test('90°: the buffer top-left corner lands at the upright top-right', () => {
    const lm = new Float64Array(LANDMARK_FLOATS);
    const up = landmarksToUpright(lm, 90);
    expect([up[0], up[1]]).toEqual([1, 0]);
    expect(uprightSize(640, 480, 90)).toEqual({ w: 480, h: 640 });
    expect(uprightSize(640, 480, 180)).toEqual({ w: 640, h: 480 });
  });
});

describe('iris offsets: the hand-built oracle (plan §M1a, rev2: R1-I1)', () => {
  /** Upright px: right eye corners 33 (10, 50) → 133 (30, 50); left 263 (70, 50) → 362 (50, 50). */
  function eyesWith(right: [number, number], left: [number, number]): Float64Array {
    const W = 100;
    const H = 100;
    const lm = new Float64Array(LANDMARK_FLOATS);
    const set = (k: number, x: number, y: number) => {
      lm[k * 3] = x / W;
      lm[k * 3 + 1] = y / H;
    };
    set(33, 10, 50);
    set(133, 30, 50);
    set(263, 70, 50);
    set(362, 50, 50);
    set(468, 20 + right[0], 50 + right[1]);
    set(473, 60 + left[0], 50 + left[1]);
    return lm;
  }

  test('both irises moved UP in the image (y smaller) → oy > 0 for BOTH eyes, ox ≈ 0', () => {
    const lm = eyesWith([0, -2], [0, -2]);
    const r = irisOffset(lm, 'R', 100, 100)!;
    const l = irisOffset(lm, 'L', 100, 100)!;
    expect(r.oy).toBeCloseTo(0.1, 12);
    expect(l.oy).toBeCloseTo(0.1, 12);
    expect(Math.abs(r.ox)).toBeLessThan(1e-12);
    expect(Math.abs(l.ox)).toBeLessThan(1e-12);
  });

  test('both irises moved toward image RIGHT → ox > 0 for BOTH eyes', () => {
    const lm = eyesWith([3, 0], [3, 0]);
    expect(irisOffset(lm, 'R', 100, 100)!.ox).toBeCloseTo(0.15, 12);
    expect(irisOffset(lm, 'L', 100, 100)!.ox).toBeCloseTo(0.15, 12);
  });

  test('a rolled eye: û follows the corners, so an iris on the corner line has oy = 0', () => {
    // Right eye tilted 30°: corners (10, 50) → (10 + 20cos30, 50 + 20sin30).
    const lm = eyesWith([0, 0], [0, 0]);
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    lm[133 * 3] = (10 + 20 * c) / 100;
    lm[133 * 3 + 1] = (50 + 20 * s) / 100;
    lm[468 * 3] = (10 + 10 * c) / 100;
    lm[468 * 3 + 1] = (50 + 10 * s) / 100;
    const r = irisOffset(lm, 'R', 100, 100)!;
    expect(Math.abs(r.oy)).toBeLessThan(1e-12);
    expect(Math.abs(r.ox)).toBeLessThan(1e-12);
  });

  test('non-square frames are aspect-corrected (pixels, not normalised units)', () => {
    const lm = eyesWith([0, -2], [0, -2]);
    // The same normalised landmarks in a 100 × 200 frame: 2 px normalised vertically becomes 4 px.
    expect(irisOffset(lm, 'R', 100, 200)!.oy).toBeCloseTo(0.2, 12);
  });
});

describe('head pose', () => {
  test('identity → 0, 0, 0', () => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -40, 1];
    const p = headPoseFromMatrix(m, 0);
    expect([p.yawDeg, p.pitchDeg, p.rollDeg].map((x) => Math.abs(x) < 1e-12)).toEqual([true, true, true]);
  });

  test('a face turned so its forward vector points to image right has yaw +90', () => {
    // Columns: x' = (0,0,−1), y' = (0,1,0), z' = f = (1,0,0).
    const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -40, 1];
    expect(headPoseFromMatrix(m, 0).yawDeg).toBeCloseTo(90, 9);
  });

  test.each([
    [20, 10, -4, 0],
    [-35, -12, 7, 90],
    [15, 25, 12, 180],
    [40, -20, -9, 270],
  ] as const)('yaw %p, pitch %p, roll %p built in the %p° buffer frame come back exactly', (yaw, pitch, roll, rot) => {
    const p = headPoseFromMatrix(matrixFromPose(yaw, pitch, roll, rot as Rotation), rot as Rotation);
    expect(p.yawDeg).toBeCloseTo(yaw, 9);
    expect(p.pitchDeg).toBeCloseTo(pitch, 9);
    expect(p.rollDeg).toBeCloseTo(roll, 9);
  });

  test('the buffer rotation matters: reading a 90° matrix as 0° gives a different pose', () => {
    const p = headPoseFromMatrix(matrixFromPose(20, 10, -4, 90), 0);
    expect(Math.abs(p.rollDeg - -4)).toBeGreaterThan(45);
  });

  test('gaze angles: forward, 45° right, 45° up (stored y is flipped)', () => {
    expect(gazeAngles([0, 0, 1])).toEqual({ yawDeg: 0, pitchDeg: -0 });
    expect(gazeAngles([1, 0, 1]).yawDeg).toBeCloseTo(45, 12);
    expect(gazeAngles([0, -1, 1]).pitchDeg).toBeCloseTo(45, 12);
  });
});

describe('luma statistics', () => {
  test('integer BT.601 and the channel order per format', () => {
    expect(luma601(255, 255, 255)).toBe(255);
    expect(luma601(255, 0, 0)).toBe(76);
    expect(luma601(0, 0, 255)).toBe(28);
    const pixel = new Uint8Array([255, 0, 0, 255]); // B=255 in BGRA, R=255 in RGBA
    expect(lumaPlane(pixel, 1, 1, 'bgra')[0]).toBe(28);
    expect(lumaPlane(pixel, 1, 1, 'rgba')[0]).toBe(76);
  });

  test('frame luma samples every 8th pixel of every 8th row', () => {
    const luma = new Uint8Array(16 * 16).fill(10);
    luma[0] = 90;
    luma[8] = 90;
    luma[8 * 16] = 90;
    luma[8 * 16 + 8] = 90;
    luma[1] = 255; // not sampled
    expect(frameLuma(luma, 16, 16)).toBe(90);
  });

  test('blur: a flat face is 0, a checkerboard is large', () => {
    const w = 128;
    const flat = new Uint8Array(w * w).fill(100);
    const rect = { x0: 0, y0: 0, x1: 128, y1: 128 };
    expect(blurScore(flat, w, rect)).toBe(0);
    const checker = Uint8Array.from({ length: w * w }, (_, i) => (((i % w) >> 1) + ((i / w) >> 1)) % 2 === 0 ? 0 : 200);
    expect(blurScore(checker, w, rect)).toBeGreaterThan(1000);
    expect(faceLuma(flat, w, rect)).toBe(100);
  });

  test('a dark iris disk in a bright sclera gives a large contrast; an all-dark eye gives none', () => {
    const W = 60;
    const H = 40;
    const lm = new Float64Array(LANDMARK_FLOATS);
    const set = (k: number, x: number, y: number) => {
      lm[k * 3] = x / W;
      lm[k * 3 + 1] = y / H;
    };
    // A right-eye contour box 10..50 × 10..30, the iris at (30, 20) with radius 5.
    const contour = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
    contour.forEach((k, i) => set(k, 10 + (40 * (i % 9)) / 8, i < 9 ? 30 : 10));
    set(468, 30, 20);
    set(469, 35, 20);
    set(470, 30, 15);
    set(471, 25, 20);
    set(472, 30, 25);
    const luma = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) luma[y * W + x] = Math.hypot(x + 0.5 - 30, y + 0.5 - 20) <= 5 ? 20 : 220;
    const bright = eyeLuma(luma, W, H, lm, 'R', 150);
    expect(bright.irisContrast).toBeCloseTo(200, 6);
    expect(bright.eyeSat).toBe(0);
    const dark = eyeLuma(new Uint8Array(W * H).fill(20), W, H, lm, 'R', 150);
    expect(dark.irisContrast).toBe(0);
    expect(dark.eyeLuma).toBeCloseTo(20 / 150, 12);
  });
});

describe('geometry', () => {
  test('point in polygon', () => {
    const lm = new Float64Array(LANDMARK_FLOATS);
    const sq = [0, 1, 2, 3];
    [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ].forEach(([x, y], k) => {
      lm[k * 3] = x!;
      lm[k * 3 + 1] = y!;
    });
    expect(insidePolygon(lm, sq, 50, 50, 100, 100)).toBe(true);
    expect(insidePolygon(lm, sq, 95, 50, 100, 100)).toBe(false);
  });

  test('an eye with a landmark outside the frame is clipped', () => {
    const lm = new Float64Array(LANDMARK_FLOATS).fill(0.5);
    lm[263 * 3] = 1.02;
    const g = geometry(lm, 100, 100);
    expect(g.left).toBeNull();
  });
});

describe('the record builder', () => {
  const luma = new Uint8Array(40 * 30).fill(33);

  test('no face → the face-absent record, with frame luma', () => {
    const r = buildRecord({
      tMs: 5,
      bufferW: 40,
      bufferH: 30,
      rotationDeg: 90,
      luma,
      landmarks: null,
      matrix: null,
      netGaze: null,
      latLandmarkMs: 1,
      latTotalMs: 2,
    });
    expect(r[I.face]).toBe(0);
    expect(r[I.frameLuma]).toBe(33);
    expect(r[I.flags]).toBe(0);
    expect(Number.isNaN(r[I.boxCx]!)).toBe(true);
    const out = decodeFrameBatch(buildFrameBatch([r], 0));
    expect(out.droppedRecords).toBe(0);
  });

  test('a face with no matrix sets POSE_MISSING; the net sets NET_RAN; the record decodes', () => {
    const lm = new Float64Array(LANDMARK_FLOATS);
    for (let i = 0; i < LANDMARK_FLOATS; i += 3) {
      lm[i] = 0.3 + ((i * 37) % 400) / 1000;
      lm[i + 1] = 0.3 + ((i * 53) % 400) / 1000;
    }
    const r = buildRecord({
      tMs: 5,
      bufferW: 40,
      bufferH: 30,
      rotationDeg: 0,
      luma,
      landmarks: lm,
      matrix: null,
      netGaze: [0, 0, 1],
      latLandmarkMs: 1,
      latTotalMs: 2,
    });
    expect(r[I.flags]! & FLAG.POSE_MISSING).toBe(FLAG.POSE_MISSING);
    expect(r[I.flags]! & FLAG.NET_RAN).toBe(FLAG.NET_RAN);
    expect(Number.isNaN(r[I.headYaw]!)).toBe(true);
    expect(r[I.netYaw]).toBe(0);
    expect(decodeFrameBatch(buildFrameBatch([r], 0)).droppedRecords).toBe(0);
  });
});

describe('the gaze-input assembler', () => {
  test('uses the tracker state BEFORE the frame, and admits only open, unclipped eyes', () => {
    const c = fixture<{ cases: { landmarks: number[][]; width: number; height: number; focal_scale: number }[] }>('gaze_inputs_cases.json').cases[0]!;
    const flat = c.landmarks.flat();
    const asm = new GazeInputAssembler();
    const first = asm.prepare(flat, c.width, c.height, c.focal_scale);
    expect(Array.from(first.inputs.context.slice(3))).toEqual(Array.from(new Float32Array([0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419])));
    expect(asm.admit(first.cloud64, 0, 0.3, 0.3, false, false)).toBe(true);
    expect(asm.admit(first.cloud64, 0.1, 0.1, 0.1, false, false)).toBe(false); // closed
    expect(asm.admit(first.cloud64, 0.2, 0.3, 0.3, true, false)).toBe(false); // clipped
  });
});
