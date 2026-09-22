// The golden-vector format and the reference runner (README §Golden vectors, §Self-test).
// Native `selfTest(vectorsJson)` receives `JSON.stringify(GoldenVector[])`, runs its own port over
// each vector's `inputs` exactly as `runVector` does here, and returns a `SelfTestOutput`.
import { extractSecond, initialExtractState } from './extract';
import { androidAccelToReference, gravityFilter, initialGravityState } from './gravityFilter';
import type { ExtractedRow, FixSample, ImuSample, PhoneSample, RawImuSample, Vec3 } from './types';

export interface ExtractVectorSecond {
  /** the end of the second, epoch ms */
  tsMs: number;
  imu: ImuSample[];
  fix: FixSample | null;
  phone: PhoneSample;
}

export interface ExtractVector {
  name: string;
  description: string;
  kind: 'extract';
  /** fed to `extractSecond` in order, from `initialExtractState()` */
  inputs: { seconds: ExtractVectorSecond[] };
  expected: { rows: ExtractedRow[] };
}

export interface GravityVector {
  name: string;
  description: string;
  kind: 'gravityFilter';
  /** each batch fed to `gravityFilter` in order, the state carried, from `initialGravityState()` */
  inputs: { batches: RawImuSample[][] };
  expected: { batches: ImuSample[][] };
}

/** One raw Android sample exactly as `SensorEvent`s deliver it (review I1). */
export interface AndroidRawSample {
  /** epoch ms (already through the time base) */
  t: number;
  /** `TYPE_ACCELEROMETER` values: m/s², Android's sign (face-up ≈ [0, 0, +9.81]) */
  values: Vec3;
  /** `TYPE_GYROSCOPE` values, rad/s */
  w: Vec3;
}

export interface AndroidRawSecond {
  tsMs: number;
  raw: AndroidRawSample[];
  fix: FixSample | null;
  phone: PhoneSample;
}

/**
 * The Android production path end to end: per second, convert with `androidAccelToReference`,
 * filter (state carried), extract (state carried). A port that skips `/ G_MPS2` or the sign fails.
 */
export interface AndroidRawVector {
  name: string;
  description: string;
  kind: 'androidRaw';
  inputs: { seconds: AndroidRawSecond[] };
  expected: { rows: ExtractedRow[] };
}

export type GoldenVector = ExtractVector | GravityVector | AndroidRawVector;
export type VectorKind = GoldenVector['kind'];

export type SelfTestResult =
  | { name: string; kind: 'extract' | 'androidRaw'; rows: ExtractedRow[] }
  | { name: string; kind: 'gravityFilter'; batches: ImuSample[][] }
  | { name: string; kind: VectorKind; error: string }
  /** iOS only, for `gravityFilter` and `androidRaw` vectors: CoreMotion supplies gravity and user acceleration */
  | { name: string; kind: 'gravityFilter' | 'androidRaw'; skipped: string };

export interface SelfTestOutput {
  version: 1;
  platform: 'ios' | 'android' | 'reference';
  /** one per input vector, in input order */
  results: SelfTestResult[];
}

export function runExtractInputs(inputs: ExtractVector['inputs']): ExtractedRow[] {
  let state = initialExtractState();
  const rows: ExtractedRow[] = [];
  for (const s of inputs.seconds) {
    const out = extractSecond(s.imu, s.fix, s.phone, s.tsMs, state);
    rows.push(out.row);
    state = out.state;
  }
  return rows;
}

export function runGravityInputs(inputs: GravityVector['inputs']): ImuSample[][] {
  let state = initialGravityState();
  return inputs.batches.map((batch) => {
    const out = gravityFilter(batch, state);
    state = out.state;
    return out.imu;
  });
}

export function runAndroidRawInputs(inputs: AndroidRawVector['inputs']): ExtractedRow[] {
  let gs = initialGravityState();
  let es = initialExtractState();
  const rows: ExtractedRow[] = [];
  for (const s of inputs.seconds) {
    const raw: RawImuSample[] = s.raw.map((r) => ({ t: r.t, a: androidAccelToReference(r.values), w: r.w }));
    const f = gravityFilter(raw, gs);
    gs = f.state;
    const out = extractSecond(f.imu, s.fix, s.phone, s.tsMs, es);
    es = out.state;
    rows.push(out.row);
  }
  return rows;
}

export function runVector(v: GoldenVector): SelfTestResult {
  try {
    switch (v.kind) {
      case 'extract':
        return { name: v.name, kind: 'extract', rows: runExtractInputs(v.inputs) };
      case 'gravityFilter':
        return { name: v.name, kind: 'gravityFilter', batches: runGravityInputs(v.inputs) };
      case 'androidRaw':
        return { name: v.name, kind: 'androidRaw', rows: runAndroidRawInputs(v.inputs) };
    }
  } catch (e) {
    return { name: v.name, kind: v.kind, error: e instanceof Error ? e.message : String(e) };
  }
}

export const runSelfTest = (
  vectors: readonly GoldenVector[],
  platform: SelfTestOutput['platform']
): SelfTestOutput => ({ version: 1, platform, results: vectors.map(runVector) });
