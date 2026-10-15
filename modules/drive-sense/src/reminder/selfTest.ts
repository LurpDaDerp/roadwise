// The forgot-to-start reminder's half of the self-test (README §10 "Self-test"). Each row of the
// decision table (`vectors.ts`) goes to native as one `reminder` vector, its `expected` left out;
// native runs it through its PRODUCTION policy mirror (`TripReminderPolicy.kt`, `.swift`), never a
// copy, and answers the row's `actual`. JS matches `actual` against the row's `expected` with the
// same matcher Jest runs over this reference (`__tests__/reminderSelfTest.test.ts`), so a native
// rule that drifts from the table fails on the phone.
//
// Android has the shared rules and the activity-transition batch; iOS the shared rules and the
// wake, fix and stop rules. A row of the other platform's rules is answered `skipped`, and a skip
// is accepted only for those rows.
import { z } from 'zod';

import { MISMATCH_CAP, type Mismatch, type SelfTestDiff, type VectorDiff } from '../selfTest';
import {
  appForeground,
  captureEnded,
  captureStarted,
  gate,
  onFix,
  onStop,
  onTransitions,
  onWake,
  onWatchEnd,
  posted,
  resolve,
  sessionEnded,
  setEnabled,
  settle,
  summarizeActivities,
  type FixVerdict,
} from './policy';
import type { ReminderVector } from './vectors';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A decision-table row as native gets it: everything but `expected`. */
export type ReminderRowInputs = DistributiveOmit<ReminderVector, 'expected'>;

/** One row on the wire to `selfTest`. */
export interface ReminderWireVector {
  name: string;
  kind: 'reminder';
  inputs: ReminderRowInputs;
}

/** What a row's run answers: `reason`, `state`, `effect`, `summary` or `verdicts`, by row kind. */
export type ReminderActual = Record<string, unknown>;

export function reminderWireVectors(rows: readonly ReminderVector[]): ReminderWireVector[] {
  return rows.map((v) => {
    const inputs: Partial<ReminderVector> = { ...v };
    delete inputs.expected;
    return { name: v.name, kind: 'reminder', inputs: inputs as ReminderRowInputs };
  });
}

export function isReminderWireVector(v: unknown): v is ReminderWireVector {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'reminder';
}

/** The reference's answer to one row: what a correct native mirror answers. */
export function runReminderRow(v: ReminderRowInputs): ReminderActual {
  switch (v.kind) {
    case 'gate':
      return { reason: gate(v.state, v.ctx, v.now, v.phase) };
    case 'ops': {
      let s = v.state;
      for (const o of v.ops) {
        if (o.op === 'settle') s = settle(s, o.now);
        else if (o.op === 'posted') s = posted(s, o.now);
        else if (o.op === 'resolve') s = resolve(s, o.outcome, o.now);
        else if (o.op === 'captureStarted') s = captureStarted(s, o.now);
        else if (o.op === 'captureEnded') s = captureEnded(s, o.now);
        else if (o.op === 'appForeground') s = appForeground(s);
        else if (o.op === 'setEnabled') s = setEnabled(s, o.on);
        else s = sessionEnded(s, o.now);
      }
      return { state: s };
    }
    case 'transitions': {
      const r = onTransitions(v.state, v.events, v.arrival, v.subscribedAt, v.ctx);
      return { effect: r.effect, reason: r.reason ?? null, state: r.state };
    }
    case 'wake': {
      const r = onWake(v.state, v.now, v.motion, v.ctx);
      return { effect: r.effect, reason: r.reason, state: r.state };
    }
    case 'summary':
      return { summary: summarizeActivities(v.activities, v.now) };
    case 'fixes': {
      let tr = v.tracker;
      const verdicts: FixVerdict[] = [];
      for (const f of v.fixes) {
        const r = onFix(tr, f.fix, f.now);
        tr = r.tracker;
        verdicts.push(r.verdict);
      }
      return { verdicts };
    }
    case 'stop': {
      const r = onStop(v.state, v.ctx, v.now, v.walked);
      return { effect: r.effect, reason: r.reason };
    }
    case 'watchEnd': {
      const r = onWatchEnd(v.state, v.how, v.now);
      return { effect: r.effect, state: r.state };
    }
  }
}

/** `expected` within `actual`: every key `expected` names, arrays whole, null and missing alike. */
function within(path: string, expected: unknown, actual: unknown, out: Mismatch[]): void {
  if (expected === null || expected === undefined) {
    if (actual !== null && actual !== undefined) out.push({ path, expected: null, actual });
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      out.push({ path, expected, actual });
      return;
    }
    expected.forEach((e, i) => within(`${path}[${i}]`, e, actual[i], out));
    return;
  }
  if (typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, expected, actual });
      return;
    }
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(e)) within(path ? `${path}.${k}` : k, e[k], a[k], out);
    return;
  }
  if (expected !== actual) out.push({ path, expected, actual });
}

/** Where `actual` departs from the row's `expected`, field by field. */
export function matchReminderRow(v: ReminderVector, actual: ReminderActual): Mismatch[] {
  const out: Mismatch[] = [];
  switch (v.kind) {
    case 'gate':
      within('reason', v.expected, actual.reason, out);
      break;
    case 'ops':
      within('state', v.expected, actual.state, out);
      break;
    case 'transitions':
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      if (v.expected.state) within('state', v.expected.state, actual.state, out);
      break;
    case 'wake': {
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      const state = actual.state as { trip?: unknown } | null | undefined;
      if (v.expected.trip !== undefined) within('state.trip', v.expected.trip, state?.trip, out);
      break;
    }
    case 'summary':
      within('summary', v.expected, actual.summary, out);
      break;
    case 'fixes':
      within('verdicts', v.expected, actual.verdicts, out);
      break;
    case 'stop':
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      break;
    case 'watchEnd':
      within('effect', v.expected.effect, actual.effect, out);
      within('state', v.expected.state, actual.state, out);
      break;
  }
  return out;
}

/** Whether a platform's native policy has this row's rules (else it answers `skipped`). */
export function reminderRowRunsOn(v: ReminderVector, platform: string): boolean {
  if (platform === 'android') {
    if (v.kind === 'gate') return v.phase === 'stop';
    if (v.kind === 'ops') return v.ops.every((o) => o.op !== 'sessionEnded');
    return v.kind === 'transitions';
  }
  if (platform === 'ios') return v.kind !== 'transitions';
  return true;
}

/** The reference's whole answer to a reminder `selfTest` call (the fake's). */
export function referenceReminderOutput(wire: readonly ReminderWireVector[]): { version: 1; platform: 'reference'; results: Record<string, unknown>[] } {
  return {
    version: 1,
    platform: 'reference',
    results: wire.map((w) => ({ name: w.name, kind: 'reminder', actual: runReminderRow(w.inputs) })),
  };
}

const outputSchema = z.object({
  version: z.literal(1),
  platform: z.string(),
  results: z.array(z.object({ name: z.string(), kind: z.string() }).passthrough()),
});

/** Diff a native `selfTest` output for the reminder rows against the rows' `expected`. Never throws. */
export function diffReminderSelfTest(rows: readonly ReminderVector[], outputJson: string): SelfTestDiff {
  let value: unknown;
  try {
    value = JSON.parse(outputJson);
  } catch {
    return { ok: false, platform: null, error: 'The native output is not JSON', results: [] };
  }
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, platform: null, error: 'The native output does not have the self-test shape', results: [] };
  const platform = parsed.data.platform;
  const byName = new Map(parsed.data.results.map((r) => [r.name, r as Record<string, unknown>]));
  const results = rows.map((v): VectorDiff => {
    const failed = (error: string): VectorDiff => ({ name: v.name, ok: false, error, mismatches: [], mismatchCount: 0 });
    const r = byName.get(v.name);
    if (!r) return failed('missing from the native output');
    if (typeof r.error === 'string') return failed(r.error);
    const runs = reminderRowRunsOn(v, platform);
    if (typeof r.skipped === 'string') {
      return runs
        ? failed(`skipped (${r.skipped}), but ${platform} has this rule`)
        : { name: v.name, ok: true, skipped: r.skipped, mismatches: [], mismatchCount: 0 };
    }
    if (r.kind !== 'reminder') return failed(`kind ${String(r.kind)} returned, reminder expected`);
    const actual = r.actual;
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return failed('no actual in the native answer');
    const mismatches = matchReminderRow(v, actual as ReminderActual);
    return { name: v.name, ok: mismatches.length === 0, mismatches: mismatches.slice(0, MISMATCH_CAP), mismatchCount: mismatches.length };
  });
  return { ok: results.every((r) => r.ok), platform, results };
}
