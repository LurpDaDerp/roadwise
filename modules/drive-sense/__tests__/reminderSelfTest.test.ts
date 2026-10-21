/** @jest-environment node */
// The forgot-to-start reminder's self-test (README §10 "Self-test"): the matcher the device diff
// uses passes the TypeScript reference on every row and catches a planted drift of each row kind,
// and the diff accepts a skip only for a row the platform does not run (iOS, which has no reminder, runs none).
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
    const flip = (x: unknown) => !(x as boolean);
    const drifted: Record<ReminderVector['kind'], (a: ReminderActual) => ReminderActual> = {
      gate: (a) => ({ ...a, reason: 'ok-ish' }),
      ops: (a) => ({ ...a, state: { ...(a.state as object), token: 'drifted', session: null, enabled: !(a.state as { enabled: boolean }).enabled } }),
      tap: (a) => ({ ...a, delivered: (a.delivered as boolean[]).map(flip) }),
      claim: (a) => ({ ...a, ok: flip(a.ok) }),
      transitions: (a) => ({ ...a, effect: a.effect === 'post' ? 'none' : 'post' }),
      expires: (a) => ({ ...a, expiresAt: (a.expiresAt as number) + 1 }),
      wake: (a) => ({ ...a, reason: 'resting-ish' }),
      summary: (a) => ({ summary: { ...(a.summary as object), onFootNow: !(a.summary as { onFootNow: boolean }).onFootNow } }),
      fixes: (a) => ({ ...a, verdicts: [...(a.verdicts as string[]), 'none'] }),
      stop: (a) => ({ ...a, effect: 'end' === a.effect ? 'post' : 'end' }),
      stored: (a) => ({ ...a, state: { ...(a.state as object), v: 2 } }),
    };
    for (const kind of Object.keys(drifted) as ReminderVector['kind'][]) {
      const v = first(kind);
      const bad = drifted[kind](runReminderRow(v));
      expect({ kind, caught: matchReminderRow(v, bad).length > 0 }).toEqual({ kind, caught: true });
    }
  });

  test('null and missing match (Kotlin writes null, Swift leaves a nil session out)', () => {
    const v = REMINDER_VECTORS.find((r) => r.kind === 'wake' && r.expected.state?.session === null)!;
    const actual = runReminderRow(v) as { state: Record<string, unknown> };
    const { session: _session, ...noSession } = actual.state;
    expect(matchReminderRow(v, { ...actual, state: noSession })).toEqual([]);
  });

  test('a claim row checks its state only when it names one, and a transitions row its timeout only when it names one', () => {
    const claimRow = REMINDER_VECTORS.find((r) => r.kind === 'claim' && r.expected.state === undefined)!;
    expect(matchReminderRow(claimRow, { ok: (runReminderRow(claimRow) as { ok: boolean }).ok })).toEqual([]);
    const tr = REMINDER_VECTORS.find((r) => r.kind === 'transitions' && r.expected.expiresAt !== undefined)!;
    expect(matchReminderRow(tr, { ...runReminderRow(tr), expiresAt: 1 }).map((m) => m.path)).toEqual(['expiresAt']);
  });

  test.each(['android', 'ios'] as const)('%s: the reference with the other platform skipped passes', (platform) => {
    const diff = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput(platform));
    expect(diff.error).toBeUndefined();
    expect(diff.results.filter((r) => !r.ok)).toEqual([]);
    expect(diff.ok).toBe(true);
    expect(diff.results.some((r) => r.skipped)).toBe(true);
  });

  test('Android runs the stop gate, the shared ops, the hand-over, its claim, the batch and the timeout; iOS has no reminder and skips every row', () => {
    const runs = (p: string) => REMINDER_VECTORS.filter((v) => reminderRowRunsOn(v, p)).map((v) => v.kind);
    expect(new Set(runs('android'))).toEqual(new Set(['gate', 'ops', 'tap', 'claim', 'transitions', 'expires', 'stored']));
    expect(runs('ios')).toEqual([]);
    for (const v of REMINDER_VECTORS) {
      if (v.kind === 'gate') expect({ v: v.name, android: reminderRowRunsOn(v, 'android') }).toEqual({ v: v.name, android: v.phase === 'stop' });
      if (v.kind === 'claim') {
        expect({ v: v.name, android: reminderRowRunsOn(v, 'android') }).toEqual({ v: v.name, android: v.requireDelivery });
        if (v.requireDelivery) expect(v.motion).toBeNull();
      }
      if (v.kind === 'ops') {
        expect({ v: v.name, android: reminderRowRunsOn(v, 'android') }).toEqual({ v: v.name, android: v.ops.every((o) => o.op !== 'lookEnded') });
      }
    }
  });

  test('a drifted answer, a wrong skip, a missing row, an error and unusable output all fail', () => {
    const name = 'android: [EXIT, STILL] in a driven session posts, the note timing out at the session end';
    const drift = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('android', (n, r) => (n === name ? { ...r, actual: { ...(r.actual as object), effect: 'none' } } : r)));
    expect(drift.ok).toBe(false);
    expect(drift.results.find((r) => r.name === name)).toMatchObject({ ok: false, mismatches: [{ path: 'effect', expected: 'post', actual: 'none' }] });

    const stop = REMINDER_VECTORS.find((v) => v.kind === 'gate' && v.phase === 'stop')!.name;
    const skipped = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('android', (n, r) => (n === stop ? { name: n, kind: 'reminder', skipped: 'x' } : r)));
    expect(skipped.results.find((r) => r.name === stop)).toMatchObject({ ok: false, error: 'skipped (x), but android has this rule' });

    const missing = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: 'renamed', kind: 'reminder', skipped: 'x' } : r)));
    expect(missing.results.find((r) => r.name === 'gate: off')).toMatchObject({ ok: false, error: 'missing from the native output' });

    const errored = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: n, kind: 'reminder', error: 'boom' } : r)));
    expect(errored.results.find((r) => r.name === 'gate: off')).toMatchObject({ ok: false, error: 'boom' });

    // an answer that is wrong fails wherever it comes from
    const answered = diffReminderSelfTest(REMINDER_VECTORS, nativeOutput('ios', (n, r) => (n === 'gate: off' ? { name: n, kind: 'reminder', actual: { reason: 'x' } } : r)));
    expect(answered.results.find((r) => r.name === 'gate: off')?.ok).toBe(false);

    expect(diffReminderSelfTest(REMINDER_VECTORS, 'nope')).toMatchObject({ ok: false, error: 'The native output is not JSON' });
    expect(diffReminderSelfTest(REMINDER_VECTORS, '{"version":2}')).toMatchObject({ ok: false });
  });

  test('the fake answers a reminder self-test with the reference', async () => {
    const fake = createFakeDriveSense();
    const out = await fake.selfTest(JSON.stringify(wire));
    expect(diffReminderSelfTest(REMINDER_VECTORS, out).ok).toBe(true);
  });
});
