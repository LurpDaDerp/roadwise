// The drive detector's half of the self-test (plan §3.3). Each row of the decision table
// (`vectors.ts`) goes to native as one `detect` vector with its `expected` left out; iOS runs it
// through its PRODUCTION policy (`DetectPolicy.swift`, via `DetectSelfTest.swift`), never a copy,
// and answers the row's `actual`. JS matches `actual` against the row's `expected` with the same
// matcher Jest runs over this reference (`__tests__/detectSelfTest.test.ts`), so a Swift rule that
// drifts from the table fails on the phone. Android has no detector: it answers every row `skipped`,
// and a skip is accepted only from Android.
import { z } from 'zod';

import { MISMATCH_CAP, type Mismatch, type SelfTestDiff, type VectorDiff } from '../selfTest';
import {
  candidateDue,
  CONFIRM_START,
  confirmStep,
  continuesFrom,
  endClockAt,
  endDue,
  endOnRow,
  lingerAfterJsEnd,
  motionGate,
  noteVeto,
  onFootVeto,
  resumeDecision,
  resumeSeq,
  startOf,
  startsAfter,
  statusOf,
  summarize,
  suppressionDue,
  suppressionResume,
  traceStart,
  VETO_START,
  wakeGate,
  type DetectRow,
} from './policy';
import type { DetectVector } from './vectors';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A decision-table row as native gets it: everything but its name and `expected`. */
export type DetectRowInputs = DistributiveOmit<DetectVector, 'expected' | 'name'>;

/** One row on the wire to `selfTest`. */
export interface DetectWireVector {
  name: string;
  kind: 'detect';
  inputs: DetectRowInputs;
}

/** What a row's run answers, by row kind. */
export type DetectActual = Record<string, unknown>;

export function detectWireVectors(rows: readonly DetectVector[]): DetectWireVector[] {
  return rows.map((v) => {
    const inputs: Partial<DetectVector> = { ...v };
    delete inputs.expected;
    delete inputs.name;
    return { name: v.name, kind: 'detect', inputs: inputs as DetectRowInputs };
  });
}

export function isDetectWireVector(v: unknown): v is DetectWireVector {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'detect';
}

/** Runs the confirmation over `rows` and answers where it confirmed (and the index of the run's first row). */
function runConfirm(v: { trigger: 'auto' | 'manual'; rows: readonly DetectRow[]; veto?: readonly boolean[]; car?: readonly boolean[] }) {
  let s = CONFIRM_START;
  for (let i = 0; i < v.rows.length; i++) {
    const r = v.rows[i]!;
    const step = confirmStep(s, r, v.trigger, v.veto?.[i] === true, v.car?.[i] === true);
    s = step.state;
    if (step.confirmed) return { c: i, runStartTs: s.runStartTs, confirmedAt: r.ts };
  }
  return null;
}

/** The reference's answer to one row: what a correct native policy answers. */
export function runDetectRow(v: DetectRowInputs): DetectActual {
  switch (v.kind) {
    case 'confirm': {
      const hit = runConfirm(v);
      return { confirmedAt: hit?.confirmedAt ?? null, runStartTs: hit?.runStartTs ?? null };
    }
    case 'trace':
      return { index: traceStart(v.rows, v.h) };
    case 'start': {
      const hit = runConfirm({ trigger: v.trigger, rows: v.rows, car: v.car });
      if (hit === null) return { confirmedAt: null, start: null };
      const buffer = v.rows.slice(0, hit.c + 1);
      const h = buffer.findIndex((r) => r.ts === hit.runStartTs);
      const s = startOf(buffer, h, v.trigger, v.automotiveSince, v.lastEnd);
      return { confirmedAt: hit.confirmedAt, start: { ...s, continues: continuesFrom(v.lastEnd, s.startedAt, s.startLat, s.startLng) } };
    }
    case 'summary':
      return { summary: summarize(v.activities, v.now) };
    case 'motionGate':
      return { reason: motionGate(v.summary, v.now) };
    case 'veto':
      return { vetoed: onFootVeto(v.reports.reduce(noteVeto, VETO_START), v.now) };
    case 'wake':
      return { reason: wakeGate(v.ctx) };
    case 'candidate':
      return { cause: candidateDue(v.trigger, v.since, v.waitUntil, v.walkSince, v.now, v.lastVehicleTs, v.hasEvidence) };
    case 'startsAfter':
      return { starts: startsAfter(v.starts, v.since, v.sawVehicle) };
    case 'end': {
      let clock = endClockAt(v.startedAt);
      const results: { due: string | null; overdue: string | null; linger: boolean }[] = [];
      for (const step of v.steps) {
        if ('row' in step) {
          clock = endOnRow(clock, step.row, step.automotive);
        } else {
          const waitUntil = step.waitUntil ?? null;
          const d = endDue(clock, v.startedAt, step.check, step.walkSince, waitUntil);
          results.push({ ...d, linger: lingerAfterJsEnd(clock, v.startedAt, step.check, step.walkSince, waitUntil) });
        }
      }
      return { results };
    }
    case 'suppress':
      return { cause: suppressionDue(v.since, v.until, v.lastOverStopTs, v.walkSince, v.now) };
    case 'suppressResume': {
      const moved = suppressionResume(v.until, v.relaunch);
      if (moved === null) return { resumed: false, causes: [] };
      return { resumed: true, causes: v.checks.map((t) => suppressionDue(v.since, v.until, moved, null, t)) };
    }
    case 'resume':
      return { decision: resumeDecision(v.lastRowTs, v.startedAt, v.now) };
    case 'resumeSeq':
      return { lastSeq: resumeSeq(v.topSeq) };
    case 'status': {
      const s = statusOf(v.inputs);
      return { status: s.status, missing: s.missing };
    }
  }
}

/** The row's `expected` in the shape of its `actual`. */
export function expectedActual(v: DetectVector): DetectActual {
  switch (v.kind) {
    case 'confirm':
    case 'start':
    case 'status':
    case 'suppressResume':
      return { ...v.expected };
    case 'trace':
      return { index: v.expected.index };
    case 'summary':
      return { summary: v.expected };
    case 'motionGate':
    case 'wake':
      return { reason: v.expected };
    case 'candidate':
    case 'suppress':
      return { cause: v.expected };
    case 'startsAfter':
      return { starts: v.expected };
    case 'veto':
      return { vetoed: v.expected };
    case 'end':
      return { results: v.expected };
    case 'resume':
      return { decision: v.expected };
    case 'resumeSeq':
      return { lastSeq: v.expected };
  }
}

/** Numbers within 1e-6 (coordinates travel as JSON doubles); null and missing alike; arrays whole. */
function within(path: string, expected: unknown, actual: unknown, out: Mismatch[]): void {
  if (expected === null || expected === undefined) {
    if (actual !== null && actual !== undefined) out.push({ path, expected: null, actual });
    return;
  }
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > 1e-6) out.push({ path, expected, actual });
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
export function matchDetectRow(v: DetectVector, actual: DetectActual): Mismatch[] {
  const out: Mismatch[] = [];
  within('', expectedActual(v), actual, out);
  return out;
}

/** The reference's whole answer to a detect `selfTest` call (the fake's). */
export function referenceDetectOutput(wire: readonly DetectWireVector[]): { version: 1; platform: 'reference'; results: Record<string, unknown>[] } {
  return {
    version: 1,
    platform: 'reference',
    results: wire.map((w) => ({ name: w.name, kind: 'detect', actual: runDetectRow(w.inputs) })),
  };
}

const outputSchema = z.object({
  version: z.literal(1),
  platform: z.string(),
  results: z.array(z.object({ name: z.string(), kind: z.string() }).passthrough()),
});

/** Diff a native `selfTest` output for the detect rows against the rows' `expected`. Never throws. */
export function diffDetectSelfTest(rows: readonly DetectVector[], outputJson: string): SelfTestDiff {
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
    if (typeof r.skipped === 'string') {
      return platform === 'android'
        ? { name: v.name, ok: true, skipped: r.skipped, mismatches: [], mismatchCount: 0 }
        : failed(`skipped (${r.skipped}), but ${platform} has the drive detector`);
    }
    if (r.kind !== 'detect') return failed(`kind ${String(r.kind)} returned, detect expected`);
    const actual = r.actual;
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return failed('no actual in the native answer');
    const mismatches = matchDetectRow(v, actual as DetectActual);
    return { name: v.name, ok: mismatches.length === 0, mismatches: mismatches.slice(0, MISMATCH_CAP), mismatchCount: mismatches.length };
  });
  return { ok: results.every((r) => r.ok), platform, results };
}
