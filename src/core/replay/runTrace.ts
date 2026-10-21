// The replay harness: feed a trace through the real detector suite and check what came out.
// `runTrace` never asserts anything itself; it returns the events, the drive's opportunity counters
// and a list of human-readable failures, so a Jest test can print exactly what the detectors did.
// The counters come from the engine's own session path (`appendRow` after the detectors, as the
// machine does it), closed as finalize closes them.
import { NO_EVENTS_FIRST_S, type Exposure } from '@scoring';

import { createDetectors } from '../detectors';
import { closeExposure } from '../engine/exposure';
import { appendRow, createSession } from '../engine/session';
import type { DetectedEvent, DetectorContext } from '../engine/types';
import type { Expectation, Trace } from './trace';
import { limitAt } from './trace';

/** Seconds either side of `startsNear` an event may start when the expectation does not say. */
export const DEFAULT_TOLERANCE_S = 2;

export interface TraceResult {
  events: DetectedEvent[];
  /** slowdowns, speed-ups, turns, limit seconds, moving seconds and phone seconds over the whole trace */
  exposure: Exposure;
  passes: boolean;
  failures: string[];
}

function counterIds(): () => string {
  let n = 0;
  return () => `e${(n += 1)}`;
}

const rel = (ts: number, base: number): string => {
  const s = (ts - base) / 1000;
  return `${s >= 0 ? '+' : ''}${s} s`;
};

const describeEvent = (e: DetectedEvent, base: number): string => `${e.type}/${e.tier} ${rel(e.startedAt, base)} ${e.durationS} s`;
const list = (events: readonly DetectedEvent[], base: number): string => (events.length ? events.map((e) => describeEvent(e, base)).join(', ') : 'none');

function checkBounds(exp: Expectation, e: DetectedEvent, base: number): string[] {
  const where = `${e.type} ${rel(e.startedAt, base)}`;
  const out: string[] = [];
  if (exp.tier !== undefined && e.tier !== exp.tier) out.push(`${where}: tier ${e.tier}, expected ${exp.tier}`);
  if (exp.durationMin !== undefined && e.durationS < exp.durationMin) out.push(`${where}: durationS ${e.durationS} is below durationMin ${exp.durationMin}`);
  if (exp.durationMax !== undefined && e.durationS > exp.durationMax) out.push(`${where}: durationS ${e.durationS} is above durationMax ${exp.durationMax}`);
  return out;
}

function checkExpectation(exp: Expectation, events: readonly DetectedEvent[], base: number): string[] {
  const ofType = events.filter((e) => e.type === exp.type);
  if (exp.absent) {
    if (ofType.length === 0) return [];
    return [`${exp.type} expected absent: ${ofType.length} turned up: ${list(ofType, base)}`];
  }
  const toleranceS = exp.toleranceS ?? DEFAULT_TOLERANCE_S;
  const near = `${exp.type} expected near ${rel(exp.startsNear, base)} (±${toleranceS} s)`;
  const matched = ofType.filter((e) => Math.abs(e.startedAt - exp.startsNear) <= toleranceS * 1000);
  if (matched.length === 0) return [`${near}: no ${exp.type} event there; ${exp.type} events: ${list(ofType, base)}`];
  if (matched.length > 1) return [`${near}: ${matched.length} ${exp.type} events there, expected one: ${list(matched, base)}`];
  return checkBounds(exp, matched[0] as DetectedEvent, base);
}

/** Replay `trace` through `createDetectors` and evaluate its expectations. The drive starts at the first row. */
export function runTrace(trace: Trace): TraceResult {
  const suite = createDetectors(counterIds());
  const base = trace.rows[0]?.ts ?? 0;
  // A drive started stopped at the first row: the 30 s warm-up.
  const ctx: DetectorContext = { warmupEndsAt: base + NO_EVENTS_FIRST_S * 1000, platform: trace.platform ?? 'ios' };
  const session = createSession({ clientTripId: trace.name, startedAt: base, origin: 'manual' });
  const events: DetectedEvent[] = [];
  for (const row of trace.rows) {
    events.push(...suite.push(row, limitAt(trace.limits, row.ts), ctx));
    appendRow(session, row, { unsafe: suite.unsafe(), limitUsable: suite.speedingNow() !== null });
  }
  events.push(...suite.flush());
  const exposure = closeExposure(session.exposure, session.movingRows);

  const noEvents = trace.noEvents && events.length > 0 ? [`expected no events at all; ${events.length} turned up: ${list(events, base)}`] : [];
  const failures = [...noEvents, ...trace.expected.flatMap((exp) => checkExpectation(exp, events, base))].map((line) => `${trace.name}: ${line}`);
  return { events, exposure, passes: failures.length === 0, failures };
}
