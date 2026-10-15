/** @jest-environment node */
// The forgot-to-start reminder's self-test (README §10 "Self-test"): the matcher the device diff
// uses passes the TypeScript reference on every row and catches a planted drift of each row kind,
// and the diff accepts a skip only for the other platform's rows.
import { createFakeDriveSense } from '../src/fake';
import {
  diffReminderSelfTest,
  matchReminderRow,
  referenceReminderOutput,
  reminderRowRunsOn,
  reminderWireVectors,
  runReminderRow,
  type ReminderActual,
} from '../src/reminder/selfTest';
import { REMINDER_VECTORS, type ReminderVector } from '../src/reminder/vectors';

const wire = reminderWireVectors(REMINDER_VECTORS);

function nativeOutput(platform: 'ios' | 'android', edit: (name: string, r: Record<string, unknown>) => Record<string, unknown> = (_n, r) => r) {
  const ref = referenceReminderOutput(wire);
  return JSON.stringify({
    version: 1,
    platform,
    results: ref.results.map((r, i) => {
      const row = REMINDER_VECTORS[i]!;
      const answer = reminderRowRunsOn(row, platform) ? r : { name: row.name, kind: 'reminder', skipped: 'the other platform' };
      return edit(row.name, answer);
    }),
  });
}

describe('the reminder self-test', () => {
  test.each(REMINDER_VECTORS.map((v) => [v.name, v] as const))('the reference passes its own row through the matcher: %s', (_n, v) => {
    // through JSON both ways, as the row and the answer travel to and from native
    const inputs = JSON.parse(JSON.stringify(wire.find((w) => w.name === v.name)!.inputs)) as typeof wire[number]['inputs'];
    const actual = JSON.parse(JSON.stringify(runReminderRow(inputs))) as ReminderActual;
    expect(matchReminderRow(v, actual)).toEqual([]);
  });

  test('a row goes to native without its answer', () => {
    expect(wire).toHaveLength(REMINDER_VECTORS.length);
    for (const w of wire) {
      expect(w.kind).toBe('reminder');
      expect('expected' in w.inputs).toBe(false);
    }
  });

  test('the matcher catches a drift of every row kind', () => {
    const first = (kind: ReminderVector['kind']) => REMINDER_VECTORS.find((v) => v.kind === kind)!;
    const drifted: Record<ReminderVector['kind'], (a: ReminderActual) => ReminderActual> = {
      gate: (a) => ({ ...a, reason: 'ok-ish' }),
      ops: (a) => ({ ...a, state: { ...(a.state as object), pendingAt: -1 } }),
      transitions: (a) => ({ ...a, effect: a.effect === 'post' ? 'none' : 'post' }),
      wake: (a) => ({ ...a, reason: 'paused' }),
      summary: (a) => ({ summary: { ...(a.summary as object), onFootNow: !(a.summary as { onFootNow: boolean }).onFootNow } }),
      fixes: (a) => ({ verdicts: [...(a.verdicts as string[]), 'none'] }),
      stop: (a) => ({ ...a, effect: 'end' === a.effect ? 'post' : 'end' }),
      watchEnd: (a) => ({ ...a, state: { ...(a.state as object), showing: true } }),
    };
    for (const kind of Object.keys(drifted) as ReminderVector['kind'][]) {
      const v = first(kind);
      const bad = drifted[kind](runReminderRow(v));
      expect({ kind, caught: matchReminderRow(v, bad).length > 0 }).toEqual({ kind, caught: true });
    }
  });

  test('null and missing match (Kotlin writes null, Swift leaves a nil trip out)', () => {
    const v = REMINDER_VECTORS.find((r) => r.kind === 'wake' && r.expected.trip === null)!;
    const actual = runReminderRow(v) as { state: Record<string, unknown> };
    const { trip: _trip, ...noTrip } = actual.state;
    expect(matchReminderRow(v, { ...actual, state: noTrip })).toEqual([]);
  });

  test.each(['android', 'ios'] as const)('%s: the reference with the other platform skipped passes', (platform) => {
    const diff = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput(platform));
    expect(diff.error).toBeUndefined();
    expect(diff.results.filter((r) => !r.ok)).toEqual([]);
    expect(diff.ok).toBe(true);
    expect(diff.results.some((r) => r.skipped)).toBe(true);
  });

  test('each platform runs its own rules: Android the stop gate, the shared ops and the batch; iOS everything else', () => {
    const runs = (p: string) => REMINDER_VECTORS.filter((v) => reminderRowRunsOn(v, p)).map((v) => v.kind);
    expect(new Set(runs('android'))).toEqual(new Set(['gate', 'ops', 'transitions']));
    expect(new Set(runs('ios'))).toEqual(new Set(['gate', 'ops', 'wake', 'summary', 'fixes', 'stop', 'watchEnd']));
    // every row runs somewhere
    for (const v of REMINDER_VECTORS) expect({ v: v.name, runs: reminderRowRunsOn(v, 'android') || reminderRowRunsOn(v, 'ios') }).toEqual({ v: v.name, runs: true });
  });

  test('a drifted answer, a wrong skip, a missing row, an error and unusable output all fail', () => {
    const name = 'android: [EXIT, STILL] in one batch posts';
    const drift = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('android', (n, r) => (n === name ? { ...r, actual: { ...(r.actual as object), effect: 'none' } } : r)));
    expect(drift.ok).toBe(false);
    expect(drift.results.find((r) => r.name === name)).toMatchObject({ ok: false, mismatches: [{ path: 'effect', expected: 'post', actual: 'none' }] });

    const skipped = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: n, kind: 'reminder', skipped: 'x' } : r)));
    expect(skipped.results.find((r) => r.name === 'gate: off')).toMatchObject({ ok: false, error: 'skipped (x), but ios has this rule' });

    const missing = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: 'renamed', kind: 'reminder', actual: {} } : r)));
    expect(missing.results.find((r) => r.name === 'gate: off')).toMatchObject({ ok: false, error: 'missing from the native output' });

    const errored = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: n, kind: 'reminder', error: 'boom' } : r)));
    expect(errored.results.find((r) => r.name === 'gate: off')).toMatchObject({ ok: false, error: 'boom' });

    expect(diffReminderSelfTest(REMINDER_VECTORS, 'nope')).toMatchObject({ ok: false, error: 'The native output is not JSON' });
    expect(diffReminderSelfTest(REMINDER_VECTORS, '{"version":2}')).toMatchObject({ ok: false });
  });

  test('the fake answers a reminder self-test with the reference', async () => {
    const fake = createFakeDriveSense();
    const out = await fake.selfTest(JSON.stringify(wire));
    expect(diffReminderSelfTest(REMINDER_VECTORS, out).ok).toBe(true);
  });
});
