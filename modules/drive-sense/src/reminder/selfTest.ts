// The forgot-to-start reminder's half of the self-test (README §10 "Self-test"). Each row of the
// decision table (`vectors.ts`) goes to native as one `reminder` vector, its `expected` left out;
// native runs it through its PRODUCTION policy mirror (`TripReminderPolicy.kt`, `.swift`), never a
// copy, and answers the row's `actual`. JS matches `actual` against the row's `expected` with the
// same matcher Jest runs over this reference (`__tests__/reminderSelfTest.test.ts`), so a native
// rule that drifts from the table fails on the phone.
//
// Android has the shared rules, the tap's hand-over, the claim with its hand-over check, the
// activity-transition batch and the note's timeout; iOS the shared rules, the claim after a motion
// fold, and the wake, look and stop rules. A row of the other platform's rules is answered
// `skipped`, and a skip is accepted only for those rows.
import { z } from 'zod';

import { MISMATCH_CAP, type Mismatch, type SelfTestDiff, type VectorDiff } from '../selfTest';
import {
  captureEnded,
  captureStarted,
  claim,
  clampTimes,
  foldCaptureTransitions,
  foldMotion,
  fromStored,
  gate,
  lookEnded,
  noteExpiresAt,
  noteGone,
  onFix,
  onStop,
  onTransitions,
  onWake,
  posted,
  setEnabled,
  settle,
  summarizeActivities,
  tapDelivered,
  unposted,
  type FixVerdict,
  type ReminderState,
} from './policy';
import type { ReminderOp, ReminderVector } from './vectors';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A decision-table row as native gets it: everything but `expected`. */
export type ReminderRowInputs = DistributiveOmit<ReminderVector, 'expected'>;

/** One row on the wire to `selfTest`. */
export interface ReminderWireVector {
  name: string;
  kind: 'reminder';
  inputs: ReminderRowInputs;
}

/** What a row's run answers (`reason`, `state`, `effect`, `ok`, `delivered`, … by row kind). */
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

function runOp(s: ReminderState, o: ReminderOp): ReminderState {
  switch (o.op) {
    case 'settle':
      return settle(s, o.now, o.capturing);
    case 'posted':
      return posted(s, o.now, o.token);
    case 'unposted':
      return unposted(s, o.token);
    case 'noteGone':
      return noteGone(s);
    case 'captureStarted':
      return captureStarted(s, o.now);
    case 'captureEnded':
      // JSON keeps a null and drops an undefined, so the three cases survive the wire.
      return 'drivingEndedAt' in o && o.drivingEndedAt !== undefined ? captureEnded(s, o.now, o.drivingEndedAt) : captureEnded(s, o.now);
    case 'captureTransitions':
      return foldCaptureTransitions(s, o.events, o.subscribedAt);
    case 'setEnabled':
      return setEnabled(s, o.on);
    case 'lookEnded':
      return lookEnded(s, o.now, o.lastFastAt, o.verdict);
  }
}

/** The reference's answer to one row: what a correct native mirror answers. */
export function runReminderRow(v: ReminderRowInputs): ReminderActual {
  switch (v.kind) {
    case 'gate':
      return { reason: gate(v.state, v.ctx, v.now, v.phase) };
    case 'ops':
      return { state: v.ops.reduce(runOp, v.state) };
    case 'tap': {
      let s = v.state;
      const delivered: boolean[] = [];
      for (const t of v.taps) {
        const r = tapDelivered(s, t.token, t.now);
        s = r.state;
        delivered.push(r.delivered);
      }
      return { delivered, state: s };
    }
    case 'claim': {
      const s = v.motion ? foldMotion(clampTimes(v.state, v.now), v.now, v.motion, v.capturing) : v.state;
      const r = claim(s, v.token, v.now, v.capturing, v.requireDelivery);
      return { ok: r.ok, state: r.state };
    }
    case 'transitions': {
      const r = onTransitions(v.state, v.events, v.arrival, v.subscribedAt, v.ctx, v.newToken);
      return { effect: r.effect, reason: r.reason ?? null, expiresAt: r.expiresAt, state: r.state };
    }
    case 'expires':
      return { expiresAt: noteExpiresAt(v.state, v.now) };
    case 'wake': {
      const r = onWake(v.state, v.now, v.motion, v.ctx);
      return { effect: r.effect, reason: r.reason, dropped: r.dropped, state: r.state };
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
      return { verdicts, lastFastAt: tr.lastFastAt };
    }
    case 'stop': {
      const r = onStop(v.state, v.ctx, v.now, v.walked, v.token, v.lastFastAt);
      return { effect: r.effect, reason: r.reason, state: r.state };
    }
    case 'stored':
      return { state: fromStored(v.stored) };
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
  /** A field the row checks only when it names it. */
  const optional = (path: string, expected: unknown) => {
    if (expected !== undefined) within(path, expected, actual[path], out);
  };
  switch (v.kind) {
    case 'gate':
      within('reason', v.expected, actual.reason, out);
      break;
    case 'ops':
    case 'stored':
      within('state', v.expected, actual.state, out);
      break;
    case 'tap':
      within('delivered', v.expected.delivered, actual.delivered, out);
      within('state', v.expected.state, actual.state, out);
      break;
    case 'claim':
      within('ok', v.expected.ok, actual.ok, out);
      optional('state', v.expected.state);
      break;
    case 'transitions':
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      optional('expiresAt', v.expected.expiresAt);
      optional('state', v.expected.state);
      break;
    case 'expires':
      within('expiresAt', v.expected, actual.expiresAt, out);
      break;
    case 'wake':
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      optional('dropped', v.expected.dropped);
      optional('state', v.expected.state);
      break;
    case 'summary':
      within('summary', v.expected, actual.summary, out);
      break;
    case 'fixes':
      within('verdicts', v.expected.verdicts, actual.verdicts, out);
      optional('lastFastAt', v.expected.lastFastAt);
      break;
    case 'stop':
      within('effect', v.expected.effect, actual.effect, out);
      within('reason', v.expected.reason, actual.reason, out);
      optional('state', v.expected.state);
      break;
  }
  return out;
}

/** Whether a platform's native policy has this row's rules (else it answers `skipped`). */
export function reminderRowRunsOn(v: ReminderVector, platform: string): boolean {
  if (platform === 'android') {
    switch (v.kind) {
      case 'gate':
        return v.phase === 'stop';
      case 'ops':
        return v.ops.every((o) => o.op !== 'lookEnded');
      case 'claim':
        return v.requireDelivery && v.motion === null;
      case 'tap':
      case 'transitions':
      case 'expires':
      case 'stored':
        return true;
      default:
        return false;
    }
  }
  if (platform === 'ios') {
    switch (v.kind) {
      case 'ops':
        return v.ops.every((o) => o.op !== 'captureTransitions');
      case 'claim':
        return !v.requireDelivery;
      case 'tap':
      case 'transitions':
      case 'expires':
        return false;
      default:
        return true;
    }
  }
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
