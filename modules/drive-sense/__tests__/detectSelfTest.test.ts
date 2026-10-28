/** @jest-environment node */
// The drive detector's self-test (plan §3.3): the wire rows carry no answers, the diff passes the
// reference and catches a planted drift of every rule, a skip is accepted only from Android (which
// has no detector), and the fake drive-sense answers a detect self-test with the reference.
import { createFakeDriveSense } from '../src/fake';
import {
  detectWireVectors,
  diffDetectSelfTest,
  matchDetectRow,
  referenceDetectOutput,
  runDetectRow,
  type DetectActual,
} from '../src/detect/selfTest';
import { DETECT_VECTORS, type DetectVector } from '../src/detect/vectors';

const wire = detectWireVectors(DETECT_VECTORS);

function nativeOutput(platform: string, edit: (name: string, r: Record<string, unknown>) => Record<string, unknown> = (_n, r) => r) {
  const ref = referenceDetectOutput(wire);
  return JSON.stringify({ version: 1, platform, results: ref.results.map((r, i) => edit(DETECT_VECTORS[i]!.name, r)) });
}

describe('the detect self-test', () => {
  test('a row goes to native without its answer or its name inside', () => {
    expect(wire).toHaveLength(DETECT_VECTORS.length);
    for (const w of wire) {
      expect(w.kind).toBe('detect');
      expect('expected' in w.inputs).toBe(false);
      expect('name' in w.inputs).toBe(false);
      expect(typeof w.inputs.kind).toBe('string');
    }
  });

  test('the iOS answers of the reference pass', () => {
    const diff = diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios'));
    expect(diff.error).toBeUndefined();
    expect(diff.results.filter((r) => !r.ok)).toEqual([]);
    expect(diff.ok).toBe(true);
  });

  test('the matcher catches a drift of every rule', () => {
    const first = (kind: DetectVector['kind']) => DETECT_VECTORS.find((v) => v.kind === kind)!;
    const drifted: Record<DetectVector['kind'], (a: DetectActual) => DetectActual> = {
      confirm: (a) => ({ ...a, confirmedAt: (a.confirmedAt as number) + 1000 }),
      trace: (a) => ({ ...a, index: ((a.index as number | null) ?? 0) + 1 }),
      start: (a) => ({ ...a, start: { ...(a.start as object), startSource: 'wake' } }),
      summary: (a) => ({ summary: { ...(a.summary as object), onFootNow: !(a.summary as { onFootNow: boolean }).onFootNow } }),
      motionGate: () => ({ reason: 'ok-ish' }),
      veto: (a) => ({ vetoed: !(a.vetoed as boolean) }),
      wake: () => ({ reason: 'resting' }),
      candidate: () => ({ cause: 'walking' }),
      startsAfter: (a) => ({ starts: [...(a.starts as number[]), 1] }),
      end: (a) => ({ results: (a.results as unknown[]).map(() => ({ due: 'limit', overdue: 'limit' })) }),
      suppress: () => ({ cause: 'never' }),
      suppressResume: (a) => ({ ...a, causes: (a.causes as unknown[]).map(() => 'still') }),
      resume: (a) => ({ decision: a.decision === 'resume' ? 'orphan' : 'resume' }),
      resumeSeq: (a) => ({ lastSeq: (a.lastSeq as number) - 999 }),
      status: (a) => ({ ...a, missing: ['motion'] }),
    };
    for (const kind of Object.keys(drifted) as DetectVector['kind'][]) {
      const v = first(kind);
      const bad = drifted[kind](runDetectRow(wire.find((w) => w.name === v.name)!.inputs));
      expect({ kind, caught: matchDetectRow(v, bad).length > 0 }).toEqual({ kind, caught: true });
    }
  });

  test('null and missing match, and numbers within 1e-6 (coordinates travel as doubles)', () => {
    const v = DETECT_VECTORS.find((r) => r.kind === 'start' && r.expected.start?.startLat !== null && r.expected.start !== null)!;
    const actual = runDetectRow(wire.find((w) => w.name === v.name)!.inputs) as { start: { startLat: number } };
    expect(matchDetectRow(v, { ...actual, start: { ...actual.start, startLat: actual.start.startLat + 1e-9 } })).toEqual([]);
    const none = DETECT_VECTORS.find((r) => r.kind === 'trace' && r.expected.index === null)!;
    expect(matchDetectRow(none, {})).toEqual([]);
  });

  test('a skip is accepted from Android only', () => {
    const name = DETECT_VECTORS[0]!.name;
    const skip = (n: string, r: Record<string, unknown>) => (n === name ? { name: n, kind: 'detect', skipped: 'no detector' } : r);
    expect(diffDetectSelfTest(DETECT_VECTORS, nativeOutput('android', skip)).results[0]).toMatchObject({ ok: true, skipped: 'no detector' });
    expect(diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios', skip)).results[0]).toMatchObject({
      ok: false,
      error: 'skipped (no detector), but ios has the drive detector',
    });
  });

  test('a drifted answer, a missing row, an error, a wrong kind and unusable output all fail', () => {
    const name = DETECT_VECTORS.find((v) => v.kind === 'confirm')!.name;
    const drift = diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios', (n, r) => (n === name ? { ...r, actual: { confirmedAt: 1, runStartTs: 1 } } : r)));
    expect(drift.ok).toBe(false);
    expect(drift.results.find((r) => r.name === name)?.mismatchCount).toBe(2);
    const missing = diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios', (n, r) => (n === name ? { ...r, name: 'renamed' } : r)));
    expect(missing.results.find((r) => r.name === name)).toMatchObject({ ok: false, error: 'missing from the native output' });
    const errored = diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios', (n, r) => (n === name ? { name: n, kind: 'detect', error: 'boom' } : r)));
    expect(errored.results.find((r) => r.name === name)).toMatchObject({ ok: false, error: 'boom' });
    const kind = diffDetectSelfTest(DETECT_VECTORS, nativeOutput('ios', (n, r) => (n === name ? { ...r, kind: 'reminder' } : r)));
    expect(kind.results.find((r) => r.name === name)).toMatchObject({ ok: false });
    expect(diffDetectSelfTest(DETECT_VECTORS, 'nope')).toMatchObject({ ok: false, error: 'The native output is not JSON' });
    expect(diffDetectSelfTest(DETECT_VECTORS, '{"version":2}')).toMatchObject({ ok: false });
  });

  test('the fake drive-sense answers a detect self-test with the reference', async () => {
    const fake = createFakeDriveSense();
    const out = await fake.selfTest(JSON.stringify(wire));
    expect(JSON.parse(out).platform).toBe('reference');
    expect(diffDetectSelfTest(DETECT_VECTORS, out).ok).toBe(true);
  });
});
