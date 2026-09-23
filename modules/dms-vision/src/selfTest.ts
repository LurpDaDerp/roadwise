// The self-test protocol, JS side (README §8): validate the golden-vector files, and diff a native
// `selfTest` output against each vector's `expected`, field by field. The diagnostics panel renders
// the result. A native `record` result is the ENCODED BATCH of the vector's frames, decoded here with
// the production decoder, so the self-test also pins the native encoder, the NaN mask and `tOffMs`.
import { z } from 'zod';
import { decodeFrameBatch, recordFromFeatures } from './wire';
import { base64ToBytes, type GoldenVector, type Num } from './reference/vectors';

/** |native − expected| ≤ ABS + REL·|expected|, per number. */
export const SELF_TEST_ABS = 1e-4;
export const SELF_TEST_REL = 1e-5;
/** A record's time is compared absolutely: a relative bound on a boot clock would hide seconds. */
export const SELF_TEST_TIME_ABS = 1e-3;
const MAX_MISMATCHES = 20;

const num = z.number();
const nullableNum = z.number().nullable();
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const base = { name: z.string().min(1), description: z.string() };

const vectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('record'),
    inputs: z.strictObject({
      anchorEpochMs: num,
      images: z.array(
        z.strictObject({ w: z.number().int().positive(), h: z.number().int().positive(), format: z.enum(['bgra', 'rgba']), pixels: z.string() })
      ),
      frames: z.array(
        z.strictObject({
          tMs: num,
          image: z.number().int().nonnegative(),
          rotationDeg: rotation,
          landmarks: z.array(num).length(1434).nullable(),
          matrix: z.array(num).length(16).nullable(),
          netGaze: z.array(num).length(3).nullable(),
          latLandmarkMs: num,
          latTotalMs: num,
        })
      ),
    }),
    expected: z.strictObject({ records: z.array(z.array(nullableNum).length(38)) }),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('gazeInputs'),
    inputs: z.strictObject({
      width: num,
      height: num,
      focalScale: num,
      frames: z.array(z.strictObject({ tSec: num, landmarks: z.array(num).length(1434) })),
    }),
    expected: z.strictObject({
      frames: z.array(
        z.strictObject({
          cloud: z.array(num).length(1434),
          context: z.array(num).length(7),
          validity: z.array(num).length(478),
          admitted: z.boolean(),
        })
      ),
    }),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('statsTracker'),
    inputs: z.strictObject({
      trainingMean: z.array(num).length(4),
      warmup: z.number().int(),
      windowS: num,
      t: z.array(num),
      pushes: z.array(z.array(nullableNum).length(4)),
    }),
    expected: z.strictObject({ current: z.array(z.array(num).length(4)) }),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('headPose'),
    inputs: z.strictObject({ cases: z.array(z.strictObject({ matrix: z.array(num).length(16), rotationDeg: rotation })) }),
    expected: z.strictObject({ poses: z.array(z.tuple([num, num, num])) }),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('onnx'),
    inputs: z.strictObject({
      cases: z.array(
        z.strictObject({ cloud: z.array(num).length(1434), context: z.array(num).length(7), validity: z.array(num).length(478) })
      ),
    }),
    expected: z.strictObject({ cases: z.array(z.strictObject({ gaze: z.array(num).length(3), rotation: z.array(num).length(9) })) }),
  }),
]);

/** Validate parsed vector files; throws with the first problem. */
export function parseVectors(raw: unknown): GoldenVector[] {
  return z.array(vectorSchema).parse(raw) as GoldenVector[];
}

export interface Mismatch {
  path: string;
  expected: Num | boolean | string;
  actual: Num | boolean | string | undefined;
}

export interface VectorDiff {
  name: string;
  kind: GoldenVector['kind'];
  ok: boolean;
  skipped?: string;
  error?: string;
  mismatches: Mismatch[];
}

export interface SelfTestDiff {
  ok: boolean;
  platform: string;
  vectors: VectorDiff[];
}

function close(a: number, e: number, absOnly = false): boolean {
  return Math.abs(a - e) <= (absOnly ? SELF_TEST_TIME_ABS : SELF_TEST_ABS + SELF_TEST_REL * Math.abs(e));
}

class Diff {
  readonly list: Mismatch[] = [];
  push(m: Mismatch) {
    if (this.list.length < MAX_MISMATCHES) this.list.push(m);
    else this.overflow = true;
  }
  overflow = false;
  /** `absOnlyIndex`: the element compared with SELF_TEST_TIME_ABS alone (a record's time). */
  nums(path: string, actual: unknown, expected: readonly Num[], absOnlyIndex = -1) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      this.push({ path: `${path}.length`, expected: expected.length, actual: Array.isArray(actual) ? actual.length : undefined });
      return;
    }
    expected.forEach((e, i) => {
      const a = actual[i] as unknown;
      if (e === null) {
        if (a !== null) this.push({ path: `${path}[${i}]`, expected: null, actual: typeof a === 'number' ? a : String(a) });
      } else if (typeof a !== 'number' || !close(a, e, i === absOnlyIndex)) {
        this.push({ path: `${path}[${i}]`, expected: e, actual: typeof a === 'number' || a === null ? a : String(a) });
      }
    });
  }
}

const outputSchema = z.strictObject({
  version: z.literal(1),
  platform: z.string(),
  gazeNetAvailable: z.boolean(),
  results: z.array(z.record(z.string(), z.unknown())),
});

/** Diff a native `selfTest` output (a JSON string) against the vectors it was given. */
export function diffSelfTest(vectors: readonly GoldenVector[], outputJson: string): SelfTestDiff {
  const out = outputSchema.parse(JSON.parse(outputJson));
  if (out.results.length !== vectors.length) {
    throw new Error(`selfTest returned ${out.results.length} results for ${vectors.length} vectors`);
  }
  const diffs = vectors.map((v, idx): VectorDiff => {
    const r = out.results[idx]!;
    const d = new Diff();
    const result = (extra: Partial<VectorDiff> = {}): VectorDiff => ({
      name: v.name,
      kind: v.kind,
      ok: d.list.length === 0 && !d.overflow,
      mismatches: d.list,
      ...extra,
    });
    if (r.name !== v.name || r.kind !== v.kind) {
      d.push({ path: 'name/kind', expected: `${v.name}/${v.kind}`, actual: `${String(r.name)}/${String(r.kind)}` });
      return result();
    }
    if (typeof r.error === 'string') return { ...result({ error: r.error }), ok: false };
    if (typeof r.skipped === 'string') {
      // Only the net's vectors may be skipped, and only on a build without the net.
      const allowed = v.kind === 'onnx' && !out.gazeNetAvailable;
      return { ...result({ skipped: r.skipped }), ok: allowed };
    }
    switch (v.kind) {
      case 'record': {
        const b = r.batch as { anchorTMs?: unknown; anchorEpochMs?: unknown; n?: unknown; data?: unknown } | undefined;
        if (!b || typeof b.data !== 'string') {
          d.push({ path: 'batch', expected: 'an encoded batch', actual: undefined });
          break;
        }
        const decoded = decodeFrameBatch({ v: 1, anchorTMs: b.anchorTMs, anchorEpochMs: b.anchorEpochMs, n: b.n, data: base64ToBytes(b.data) });
        if (decoded.batch === null) {
          d.push({ path: 'batch', expected: 'a valid header', actual: 'broken' });
          break;
        }
        if (decoded.droppedRecords > 0) d.push({ path: 'batch.droppedRecords', expected: 0, actual: decoded.droppedRecords });
        if (typeof b.anchorEpochMs !== 'number' || !close(b.anchorEpochMs, v.inputs.anchorEpochMs)) {
          d.push({ path: 'batch.anchorEpochMs', expected: v.inputs.anchorEpochMs, actual: typeof b.anchorEpochMs === 'number' ? b.anchorEpochMs : undefined });
        }
        const actual = decoded.batch.frames.map((f) => recordFromFeatures(f).map((x) => (Number.isNaN(x) ? null : x)));
        if (actual.length !== v.expected.records.length) {
          d.push({ path: 'records.length', expected: v.expected.records.length, actual: actual.length });
          break;
        }
        v.expected.records.forEach((e, i) => d.nums(`records[${i}]`, actual[i], e, 0));
        break;
      }
      case 'gazeInputs': {
        const frames = r.frames as { cloud: unknown; context: unknown; validity: unknown; admitted: unknown }[] | undefined;
        if (!Array.isArray(frames) || frames.length !== v.expected.frames.length) {
          d.push({ path: 'frames.length', expected: v.expected.frames.length, actual: Array.isArray(frames) ? frames.length : undefined });
          break;
        }
        v.expected.frames.forEach((e, i) => {
          const a = frames[i]!;
          d.nums(`frames[${i}].cloud`, a.cloud, e.cloud);
          d.nums(`frames[${i}].context`, a.context, e.context);
          d.nums(`frames[${i}].validity`, a.validity, e.validity);
          if (a.admitted !== e.admitted) d.push({ path: `frames[${i}].admitted`, expected: e.admitted, actual: a.admitted as boolean });
        });
        break;
      }
      case 'statsTracker': {
        const current = r.current as unknown[] | undefined;
        if (!Array.isArray(current) || current.length !== v.expected.current.length) {
          d.push({ path: 'current.length', expected: v.expected.current.length, actual: Array.isArray(current) ? current.length : undefined });
          break;
        }
        v.expected.current.forEach((e, i) => d.nums(`current[${i}]`, current[i], e));
        break;
      }
      case 'headPose': {
        const poses = r.poses as unknown[] | undefined;
        if (!Array.isArray(poses) || poses.length !== v.expected.poses.length) {
          d.push({ path: 'poses.length', expected: v.expected.poses.length, actual: Array.isArray(poses) ? poses.length : undefined });
          break;
        }
        v.expected.poses.forEach((e, i) => d.nums(`poses[${i}]`, poses[i], e));
        break;
      }
      case 'onnx': {
        const cases = r.cases as { gaze: unknown; rotation: unknown }[] | undefined;
        if (!Array.isArray(cases) || cases.length !== v.expected.cases.length) {
          d.push({ path: 'cases.length', expected: v.expected.cases.length, actual: Array.isArray(cases) ? cases.length : undefined });
          break;
        }
        v.expected.cases.forEach((e, i) => {
          d.nums(`cases[${i}].gaze`, cases[i]!.gaze, e.gaze);
          d.nums(`cases[${i}].rotation`, cases[i]!.rotation, e.rotation);
        });
        break;
      }
    }
    return result();
  });
  return { ok: diffs.every((x) => x.ok), platform: out.platform, vectors: diffs };
}
