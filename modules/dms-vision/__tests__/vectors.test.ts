/** @jest-environment node */
// The golden vectors the native ports must reproduce (README §8). Two properties:
// - committed JSON must be byte-for-byte a fresh generation, and every `expected` must be what the
//   reference computes from its `inputs` (ONNX: from Python, checked for shape);
// - the vectors must actually exercise the rules they are named for: clipping, POSE_MISSING,
//   NET_RAN, face absence, sunglasses, glare, closure, low light, every rotation, both pixel formats,
//   a week of uptime. A vector that stops covering its case fails here.
import { FLAG, FRAME_FIELDS, type FrameField } from '../src/constants';
import {
  runGazeInputsVector,
  runHeadPoseVector,
  runRecordVector,
  runStatsTrackerVector,
  nullToNan,
  type GoldenVector,
  type Num,
} from '../src/reference/vectors';
import { parseVectors } from '../src/selfTest';
import { buildFrameBatch, decodeFrameBatch } from '../src/wire';
import { VECTOR_NAMES, buildVectors, onnxInputs, serializeVector, type V1TrackerFixture } from '../scripts/vectorBuilders';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string) => string[]; readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const DIR = path.join(__dirname, '..', 'assets', 'vectors');
const text = (name: string) => fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8');
const v1Tracker = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'v1-reference', 'gaze_inputs_stats_tracker.json'), 'utf8')
) as V1TrackerFixture;
const fresh = buildVectors(v1Tracker);
const vectors = parseVectors(VECTOR_NAMES.map((n) => JSON.parse(text(n))));
const byName = Object.fromEntries(vectors.map((v) => [v.name, v])) as Record<string, GoldenVector>;
const I = Object.fromEntries(FRAME_FIELDS.map((f, i) => [f, i])) as Record<FrameField, number>;

test('exactly the named vectors are on disk, and every file validates', () => {
  const onDisk = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  expect(onDisk).toEqual([...VECTOR_NAMES].sort());
  expect(vectors.map((v) => v.name)).toEqual([...VECTOR_NAMES]);
});

test.each(VECTOR_NAMES.filter((n) => n !== 'onnx-parity'))('%s is byte-for-byte a fresh generation', (name) => {
  expect(text(name)).toBe(serializeVector(fresh[name]));
});

test('onnx-parity: the inputs are a fresh generation and Python filled one output per case', () => {
  const v = byName['onnx-parity']!;
  if (v.kind !== 'onnx') throw new Error('kind');
  expect(JSON.stringify(v.inputs.cases)).toBe(JSON.stringify(onnxInputs()));
  expect(v.expected.cases).toHaveLength(v.inputs.cases.length);
  for (const c of v.expected.cases) {
    expect(c.gaze.every(Number.isFinite)).toBe(true);
    expect(c.rotation.every(Number.isFinite)).toBe(true);
    // gaze_direct outputs a unit direction ("output_mode": "vector").
    expect(Math.hypot(c.gaze[0]!, c.gaze[1]!, c.gaze[2]!)).toBeCloseTo(1, 3);
  }
});

describe('every expected is the reference over its inputs', () => {
  test.each(vectors.filter((v) => v.kind !== 'onnx').map((v) => [v.name, v] as const))('%s', (_n, v) => {
    switch (v.kind) {
      case 'record':
        expect(runRecordVector(v.inputs)).toEqual(v.expected.records);
        break;
      case 'gazeInputs':
        expect(runGazeInputsVector(v.inputs)).toEqual(v.expected.frames);
        break;
      case 'statsTracker':
        expect(runStatsTrackerVector(v.inputs)).toEqual(v.expected.current);
        break;
      case 'headPose':
        expect(runHeadPoseVector(v.inputs)).toEqual(v.expected.poses);
        break;
      default:
        throw new Error('unexpected');
    }
  });
});

function records(name: string): Num[][] {
  const v = byName[name]!;
  if (v.kind !== 'record') throw new Error(`${name} is not a record vector`);
  return v.expected.records;
}
const field = (r: Num[], f: FrameField) => r[I[f]]!;

describe('the record vectors cover their cases', () => {
  test('every record vector encodes and decodes with no drop, and tMs survives a week of uptime', () => {
    for (const name of VECTOR_NAMES.filter((n) => n.startsWith('record-'))) {
      const v = byName[name]!;
      if (v.kind !== 'record') throw new Error('kind');
      const rs = v.expected.records;
      const out = decodeFrameBatch(buildFrameBatch(rs.map((r) => r.map(nullToNan)), v.inputs.anchorEpochMs));
      expect(out.droppedRecords).toBe(0);
      out.batch!.frames.forEach((f, i) => expect(Math.abs(f.tMs - v.inputs.frames[i]!.tMs)).toBeLessThan(1e-4));
      expect(v.inputs.frames[0]!.tMs).toBeGreaterThan(6e8);
    }
  });

  test('tracked BGRA at 90°: faces, no flags on the first two, NET_RAN on the third', () => {
    const rs = records('record-tracked-bgra-90');
    expect(rs.map((r) => field(r, 'flags'))).toEqual([0, 0, FLAG.NET_RAN]);
    expect(rs.every((r) => field(r, 'face') === 1 && field(r, 'irisInR') === 1 && field(r, 'irisInL') === 1)).toBe(true);
    expect(field(rs[2]!, 'netYaw')).toBeCloseTo(14, 0);
    expect(field(rs[2]!, 'netPitch')).toBeCloseTo(-8, 0);
    // The second frame's irises sit further right and up.
    expect(field(rs[1]!, 'irisOxR')!).toBeGreaterThan(field(rs[0]!, 'irisOxR')!);
    expect(field(rs[1]!, 'irisOyL')!).toBeGreaterThan(field(rs[0]!, 'irisOyL')!);
  });

  test('rotations 0/180/270: the same pose reads the same head angles, and the upright geometry agrees', () => {
    const rs = records('record-rotations');
    expect(rs.map((r) => field(r, 'rotationDeg'))).toEqual([0, 180, 270]);
    for (const r of rs) {
      expect(field(r, 'headYaw')).toBeCloseTo(20, 4);
      expect(field(r, 'headPitch')).toBeCloseTo(10, 4);
      expect(field(r, 'headRoll')).toBeCloseTo(-4, 4);
      expect(field(r, 'irisOxR')!).toBeGreaterThan(0);
      expect(field(r, 'irisOyR')!).toBeLessThan(0);
    }
  });

  test('Android RGBA at 270°: a tracked frame, then face absent', () => {
    const rs = records('record-android-rgba-270');
    expect(rs.map((r) => field(r, 'face'))).toEqual([1, 0]);
    expect(field(rs[1]!, 'boxCx')).toBeNull();
    expect(field(rs[1]!, 'frameLuma')!).toBeGreaterThan(0);
  });

  test('clipped: the left eye; then the mouth with POSE_MISSING', () => {
    const rs = records('record-clipped');
    expect(field(rs[0]!, 'flags')).toBe(FLAG.EYE_CLIPPED_L);
    expect(field(rs[0]!, 'earL')).toBeNull();
    expect(field(rs[0]!, 'irisInL')).toBe(0);
    expect(field(rs[0]!, 'earR')).not.toBeNull();
    expect(field(rs[1]!, 'flags')).toBe(FLAG.MOUTH_CLIPPED | FLAG.POSE_MISSING);
    expect(field(rs[1]!, 'mar')).toBeNull();
    expect(field(rs[1]!, 'headYaw')).toBeNull();
  });

  test('quality: sunglasses, glare, closed eyes, low light, dark and empty', () => {
    const [sun, glare, closed, dark, empty] = records('record-quality');
    expect(field(sun!, 'eyeLumaR')!).toBeLessThan(0.45);
    expect(field(sun!, 'eyeLumaL')!).toBeLessThan(0.45);
    expect(field(sun!, 'irisContrastR')!).toBeLessThan(12);
    expect(field(glare!, 'eyeSatR')!).toBeGreaterThan(0.25);
    expect(field(glare!, 'eyeSatL')!).toBe(0);
    expect(field(closed!, 'earR')!).toBeLessThan(0.1);
    expect(field(closed!, 'irisInR')).toBe(0);
    expect(field(dark!, 'faceLuma')!).toBeLessThan(50);
    expect(field(empty!, 'face')).toBe(0);
    expect(field(empty!, 'frameLuma')!).toBeLessThan(25);
    // A healthy open eye for contrast, from the tracked vector.
    const open = records('record-tracked-bgra-90')[0]!;
    expect(field(open, 'eyeLumaR')!).toBeGreaterThan(0.45);
    expect(field(open, 'irisContrastR')!).toBeGreaterThan(12);
    expect(field(open, 'earR')!).toBeGreaterThan(0.2);
    expect(field(open, 'blur')!).toBeGreaterThan(0);
  });

  test('gaze inputs: three admitted frames, then a closed-eye frame that is not', () => {
    const v = byName['gaze-inputs']!;
    if (v.kind !== 'gazeInputs') throw new Error('kind');
    expect(v.expected.frames.map((f) => f.admitted)).toEqual([true, true, true, false]);
  });
});
