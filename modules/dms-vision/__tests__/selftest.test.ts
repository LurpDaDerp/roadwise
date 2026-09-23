/** @jest-environment node */
// The JS half of the self-test protocol: a faithful native output passes, and every way a port can be
// wrong fails with a named path. "Native" here is emulated from the reference (what a correct port
// returns), then perturbed.
import { FRAME_FIELDS } from '../src/constants';
import { diffSelfTest, parseVectors } from '../src/selfTest';
import {
  base64ToBytes,
  bytesToBase64,
  recordBatchOutput,
  runGazeInputsVector,
  runHeadPoseVector,
  runStatsTrackerVector,
  type GoldenVector,
} from '../src/reference/vectors';
import { VECTOR_NAMES } from '../scripts/vectorBuilders';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const vectors = parseVectors(
  VECTOR_NAMES.map((n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'vectors', `${n}.json`), 'utf8')))
);

/** What a correct native port returns for one vector. */
function nativeResult(v: GoldenVector, gazeNet: boolean): Record<string, unknown> {
  const head = { name: v.name, kind: v.kind };
  switch (v.kind) {
    case 'record':
      return { ...head, batch: recordBatchOutput(v.inputs) };
    case 'gazeInputs':
      return { ...head, frames: runGazeInputsVector(v.inputs) };
    case 'statsTracker':
      return { ...head, current: runStatsTrackerVector(v.inputs) };
    case 'headPose':
      return { ...head, poses: runHeadPoseVector(v.inputs) };
    case 'onnx':
      return gazeNet ? { ...head, cases: v.expected.cases } : { ...head, skipped: 'gaze net not built' };
  }
}

function output(results: Record<string, unknown>[], gazeNetAvailable: boolean) {
  return JSON.stringify({ version: 1, platform: 'test', gazeNetAvailable, results });
}

const faithful = (gazeNet: boolean) => vectors.map((v) => nativeResult(v, gazeNet));

test('a faithful port passes, with and without the gaze net', () => {
  const withNet = diffSelfTest(vectors, output(faithful(true), true));
  expect(withNet.vectors.filter((v) => !v.ok)).toEqual([]);
  expect(withNet.ok).toBe(true);
  const noNet = diffSelfTest(vectors, output(faithful(false), false));
  expect(noNet.ok).toBe(true);
  expect(noNet.vectors.find((v) => v.kind === 'onnx')!.skipped).toBe('gaze net not built');
});

test('skipping the net is refused on a build that claims to have it', () => {
  const d = diffSelfTest(vectors, output(faithful(false), true));
  expect(d.ok).toBe(false);
});

test('skipping anything but the net is refused', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.kind === 'headPose');
  results[i] = { name: vectors[i]!.name, kind: 'headPose', skipped: 'lazy' };
  expect(diffSelfTest(vectors, output(results, true)).ok).toBe(false);
});

test('an error result fails its vector', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.kind === 'statsTracker');
  results[i] = { name: vectors[i]!.name, kind: 'statsTracker', error: 'boom' };
  const d = diffSelfTest(vectors, output(results, true));
  expect(d.ok).toBe(false);
  expect(d.vectors[i]!.error).toBe('boom');
});

test('a wrong head-pose sign is found and named', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.kind === 'headPose');
  const poses = (results[i]!.poses as number[][]).map((p) => [-p[0]!, p[1]!, p[2]!]);
  results[i] = { ...results[i]!, poses };
  const d = diffSelfTest(vectors, output(results, true));
  expect(d.ok).toBe(false);
  expect(d.vectors[i]!.mismatches[0]!.path).toBe('poses[0][0]');
});

test('a record whose encoded field is off by 1e-3 fails, naming the record and field', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.name === 'record-tracked-bgra-90');
  const batch = results[i]!.batch as { data: string };
  const bytes = base64ToBytes(batch.data);
  const view = new DataView(bytes.buffer);
  const k = FRAME_FIELDS.indexOf('earR');
  view.setFloat32(k * 4, view.getFloat32(k * 4, true) + 1e-3, true);
  results[i] = { ...results[i]!, batch: { ...batch, data: bytesToBase64(bytes) } };
  const d = diffSelfTest(vectors, output(results, true));
  expect(d.ok).toBe(false);
  expect(d.vectors[i]!.mismatches[0]!.path).toBe(`records[0][${k}]`);
});

test('a native encoder that leaks a stale value into a NaN slot is dropped by the decoder and fails', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.name === 'record-clipped');
  const batch = results[i]!.batch as { data: string };
  const bytes = base64ToBytes(batch.data);
  const view = new DataView(bytes.buffer);
  view.setFloat32(FRAME_FIELDS.indexOf('earL') * 4, 0.3, true); // record 0's left eye is clipped
  results[i] = { ...results[i]!, batch: { ...batch, data: bytesToBase64(bytes) } };
  const d = diffSelfTest(vectors, output(results, true));
  expect(d.vectors[i]!.ok).toBe(false);
  expect(d.vectors[i]!.mismatches.map((m) => m.path)).toContain('batch.droppedRecords');
});

test('a port that writes absolute time into the record (anchor 0) fails at a week of uptime', () => {
  const results = faithful(true);
  const i = vectors.findIndex((v) => v.name === 'record-tracked-bgra-90');
  const v = vectors[i]!;
  if (v.kind !== 'record') throw new Error('kind');
  const batch = results[i]!.batch as { anchorTMs: number; data: string };
  const bytes = base64ToBytes(batch.data);
  const view = new DataView(bytes.buffer);
  v.inputs.frames.forEach((f, r) => view.setFloat32(r * 152, f.tMs, true));
  results[i] = { ...results[i]!, batch: { ...batch, anchorTMs: 0, data: bytesToBase64(bytes) } };
  const d = diffSelfTest(vectors, output(results, true));
  expect(d.vectors[i]!.ok).toBe(false);
});

test('the wrong number of results throws', () => {
  expect(() => diffSelfTest(vectors, output(faithful(true).slice(1), true))).toThrow(/results/);
});

test('base64 round trip', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
  for (const n of [0, 1, 2, 3, 999, 1000]) expect(base64ToBytes(bytesToBase64(bytes.slice(0, n)))).toEqual(bytes.slice(0, n));
  expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
});
