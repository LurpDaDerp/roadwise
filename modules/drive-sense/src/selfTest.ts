// The self-test protocol, JS side (README §Self-test): validate the golden-vector files, and diff
// a native `selfTest` output against each vector's `expected`, field by field, within
// SELF_TEST_TOLERANCE. U5's diagnostics screen renders the `SelfTestDiff`.
import { z } from 'zod';
import { SELF_TEST_TOLERANCE } from './extract/constants';
import type { GoldenVector } from './extract/vectors';
import { rowWireSchema } from './rowSchema';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const imuSample = z.strictObject({ t: z.number(), ua: vec3, g: vec3, w: vec3 });
const rawSample = z.strictObject({ t: z.number(), a: vec3, w: vec3 });
const fix = z.strictObject({
  t: z.number(),
  lat: z.number(),
  lng: z.number(),
  hAcc: z.number(),
  speed: z.number(),
  speedAcc: z.number(),
  course: z.number(),
  alt: z.number(),
});
const phone = z.strictObject({ locked: z.boolean(), screenOn: z.boolean(), appForeground: z.boolean() });

const vectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    kind: z.literal('extract'),
    inputs: z.strictObject({
      seconds: z.array(
        z.strictObject({ tsMs: z.number(), imu: z.array(imuSample), fix: fix.nullable(), phone })
      ),
    }),
    expected: z.strictObject({ rows: z.array(rowWireSchema) }),
  }),
  z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    kind: z.literal('androidRaw'),
    inputs: z.strictObject({
      seconds: z.array(
        z.strictObject({
          tsMs: z.number(),
          raw: z.array(z.strictObject({ t: z.number(), values: vec3, w: vec3 })),
          fix: fix.nullable(),
          phone,
        })
      ),
    }),
    expected: z.strictObject({ rows: z.array(rowWireSchema) }),
  }),
  z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    kind: z.literal('gravityFilter'),
    inputs: z.strictObject({ batches: z.array(z.array(rawSample)) }),
    expected: z.strictObject({ batches: z.array(z.array(imuSample)) }),
  }),
]);

/** Parse a JSON array of golden vectors (the files under assets/vectors, bracketed). Throws on anything else. */
export function parseVectors(json: string): GoldenVector[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Invalid vector JSON');
  }
  const parsed = z.array(vectorSchema).safeParse(value);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid vector file: ${where}`);
  }
  return parsed.data as GoldenVector[];
}

export interface Mismatch {
  /** e.g. `rows[8].aLonMin`, `batches[2][3].g[0]` */
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface VectorDiff {
  name: string;
  ok: boolean;
  /** why the vector could not be compared at all (missing, native error, shape) */
  error?: string;
  /** the platform legitimately did not run it (iOS: gravity-filter and android-raw vectors) */
  skipped?: string;
  /** the first MISMATCH_CAP mismatches */
  mismatches: Mismatch[];
  mismatchCount: number;
}

export interface SelfTestDiff {
  ok: boolean;
  platform: string | null;
  /** the output as a whole was unusable */
  error?: string;
  results: VectorDiff[];
}

export const MISMATCH_CAP = 20;

const outputSchema = z.object({
  version: z.literal(1),
  platform: z.string(),
  results: z.array(z.object({ name: z.string(), kind: z.string() }).passthrough()),
});

function compare(expected: unknown, actual: unknown, path: string, out: Mismatch[], tol: number) {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
      out.push({ path, expected, actual });
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push({ path, expected, actual });
      return;
    }
    expected.forEach((e, i) => compare(e, actual[i], `${path}[${i}]`, out, tol));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, expected, actual });
      return;
    }
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    for (const k of Object.keys(e)) compare(e[k], a[k], path ? `${path}.${k}` : k, out, tol);
    for (const k of Object.keys(a)) if (!(k in e)) out.push({ path: path ? `${path}.${k}` : k, expected: undefined, actual: a[k] });
    return;
  }
  if (expected !== actual) out.push({ path, expected, actual });
}

/** Diff a native `selfTest` output (JSON) against the vectors it was given. Never throws. */
export function diffSelfTest(
  vectors: readonly GoldenVector[],
  outputJson: string,
  tolerance: number = SELF_TEST_TOLERANCE
): SelfTestDiff {
  let value: unknown;
  try {
    value = JSON.parse(outputJson);
  } catch {
    return { ok: false, platform: null, error: 'The native output is not JSON', results: [] };
  }
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) {
    const version = (value as { version?: unknown } | null)?.version;
    return {
      ok: false,
      platform: null,
      error:
        version !== 1
          ? `Unsupported self-test output version ${String(version)}`
          : 'The native output does not have the self-test shape',
      results: [],
    };
  }
  const byName = new Map(parsed.data.results.map((r) => [r.name, r as Record<string, unknown>]));
  const results = vectors.map((v): VectorDiff => {
    const r = byName.get(v.name);
    const failed = (error: string): VectorDiff => ({ name: v.name, ok: false, error, mismatches: [], mismatchCount: 0 });
    if (!r) return failed('missing from the native output');
    if (typeof r.error === 'string') return failed(r.error);
    if (typeof r.skipped === 'string') {
      return parsed.data.platform === 'ios' && v.kind !== 'extract'
        ? { name: v.name, ok: true, skipped: r.skipped, mismatches: [], mismatchCount: 0 }
        : failed(`skipped (${r.skipped}), which only iOS may do and only for gravity-filter and android-raw vectors`);
    }
    if (r.kind !== v.kind) return failed(`kind ${String(r.kind)} returned, ${v.kind} expected`);
    const key = v.kind === 'gravityFilter' ? 'batches' : 'rows';
    const expected: unknown[] = v.kind === 'gravityFilter' ? v.expected.batches : v.expected.rows;
    const actual = r[key];
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return failed(
        `${key} length ${Array.isArray(actual) ? actual.length : 'missing'}, ${expected.length} expected`
      );
    }
    const mismatches: Mismatch[] = [];
    compare(expected, actual, key, mismatches, tolerance);
    return {
      name: v.name,
      ok: mismatches.length === 0,
      mismatches: mismatches.slice(0, MISMATCH_CAP),
      mismatchCount: mismatches.length,
    };
  });
  return { ok: results.every((r) => r.ok), platform: parsed.data.platform, results };
}
