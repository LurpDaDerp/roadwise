// The golden-vector format and the reference runner (README §Golden vectors, §Self-test).
// Native `selfTest(vectorsJson)` receives `JSON.stringify(GoldenVector[])`, runs its own port over
// each vector's `inputs` exactly as `runVector` does here, and returns a `SelfTestOutput`.
import { extractSecond, initialExtractState } from './extract';
import { gravityFilter, initialGravityState } from './gravityFilter';
import type { ExtractedRow, FixSample, ImuSample, PhoneSample, RawImuSample } from './types';

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

export type GoldenVector = ExtractVector | GravityVector;

export type SelfTestResult =
  | { name: string; kind: 'extract'; rows: ExtractedRow[] }
  | { name: string; kind: 'gravityFilter'; batches: ImuSample[][] }
  | { name: string; kind: 'extract' | 'gravityFilter'; error: string }
  /** iOS only, for `gravityFilter` vectors: CoreMotion supplies gravity, there is no filter to test */
  | { name: string; kind: 'gravityFilter'; skipped: string };

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

export function runVector(v: GoldenVector): SelfTestResult {
  try {
    return v.kind === 'extract'
      ? { name: v.name, kind: 'extract', rows: runExtractInputs(v.inputs) }
      : { name: v.name, kind: 'gravityFilter', batches: runGravityInputs(v.inputs) };
  } catch (e) {
    return { name: v.name, kind: v.kind, error: e instanceof Error ? e.message : String(e) };
  }
}

export const runSelfTest = (
  vectors: readonly GoldenVector[],
  platform: SelfTestOutput['platform']
): SelfTestOutput => ({ version: 1, platform, results: vectors.map(runVector) });
