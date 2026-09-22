// The replay harness: feed a trace through the real detector suite and check what came out.
//
// This is the regression suite for §9.3–§9.5. `runTrace` never asserts anything itself; it returns
// the events and a list of human-readable failures, so a Jest test can print exactly what the
// detectors did instead of "expected true, received false".
import { createDetectors } from '../detectors';
import type { DetectedEvent, DetectorContext } from '../engine/types';
import type { Expectation, Trace } from './trace';
import { limitAt } from './trace';

/** Seconds either side of `startsNear` an event may start when the expectation does not say. */
export const DEFAULT_TOLERANCE_S = 2;

export interface TraceResult {
  /** Everything `push` returned, in row order, then everything `flush` closed. */
  events: DetectedEvent[];
  passes: boolean;
  /** One line per unmet expectation, naming the event that did or did not turn up. */
  failures: string[];
}

/** e1, e2, … — the ids have to be the same on every run for the failure lines to be comparable. */
function counterIds(): () => string {
  let n = 0;
  return () => `e${(n += 1)}`;
}

/** Times are reported relative to the first row: "+45 s" is readable, an epoch is not. */
const rel = (ts: number, base: number): string => {
  const s = (ts - base) / 1000;
  return `${s >= 0 ? '+' : ''}${s} s`;
};

const describeEvent = (e: DetectedEvent, base: number): string =>
  `${e.category} ${rel(e.startedAt, base)} q=${e.q.toFixed(2)} ${e.status} ${e.durationS} s`;

const list = (events: readonly DetectedEvent[], base: number): string =>
  events.length ? events.map((e) => describeEvent(e, base)).join(', ') : 'none';

function checkBounds(exp: Expectation, e: DetectedEvent, base: number): string[] {
  const where = `${e.category} ${rel(e.startedAt, base)}`;
  const out: string[] = [];
  if (exp.status !== undefined && e.status !== exp.status) {
    out.push(`${where}: status ${e.status}, expected ${exp.status}`);
  }
  if (exp.qMin !== undefined && e.q < exp.qMin) {
    out.push(`${where}: q ${e.q.toFixed(2)} is below qMin ${exp.qMin}`);
  }
  if (exp.qMax !== undefined && e.q > exp.qMax) {
    out.push(`${where}: q ${e.q.toFixed(2)} is above qMax ${exp.qMax}`);
  }
  if (exp.durationMin !== undefined && e.durationS < exp.durationMin) {
    out.push(`${where}: durationS ${e.durationS} is below durationMin ${exp.durationMin}`);
  }
  if (exp.durationMax !== undefined && e.durationS > exp.durationMax) {
    out.push(`${where}: durationS ${e.durationS} is above durationMax ${exp.durationMax}`);
  }
  return out;
}

function checkExpectation(
  exp: Expectation,
  events: readonly DetectedEvent[],
  base: number
): string[] {
  const inCategory = events.filter((e) => e.category === exp.category);
  if (exp.absent) {
    // "Absent" is about the score: a `possible` event is logged for the summary and costs nothing,
    // so only a scored one breaks the expectation.
    const scored = inCategory.filter((e) => e.status === 'scored');
    if (scored.length === 0) return [];
    const plural = scored.length === 1 ? 'event' : 'events';
    return [
      `${exp.category} expected absent: ${scored.length} scored ${exp.category} ${plural}: ` +
        list(scored, base),
    ];
  }

  const toleranceS = exp.toleranceS ?? DEFAULT_TOLERANCE_S;
  const near = `${exp.category} expected near ${rel(exp.startsNear, base)} (±${toleranceS} s)`;
  const matched = inCategory.filter(
    (e) => Math.abs(e.startedAt - exp.startsNear) <= toleranceS * 1000
  );
  if (matched.length === 0) {
    return [
      `${near}: no ${exp.category} event there; ${exp.category} events: ${list(inCategory, base)}`,
    ];
  }
  if (matched.length > 1) {
    return [
      `${near}: ${matched.length} ${exp.category} events there, expected one: ${list(matched, base)}`,
    ];
  }
  return checkBounds(exp, matched[0] as DetectedEvent, base);
}

/**
 * Replay `trace` through `createDetectors` and evaluate its expectations.
 *
 * Each row is fed the limit in force at its own `ts`, and the trace's mode, night, precipitation
 * and lock signal (reliable when the trace does not say) as the detector context; whatever is still open at the end is closed by `flush`.
 */
export function runTrace(trace: Trace): TraceResult {
  const suite = createDetectors(counterIds());
  const ctx: DetectorContext = {
    mode: trace.mode,
    night: trace.night,
    precipitation: trace.precipitation,
    // A trace without a lock signal was recorded on a platform whose lock state can be believed.
    lockReliable: trace.lockSignal !== 'unreliable',
    lockLagged: trace.lockSignal === 'lagged',
  };
  const events: DetectedEvent[] = [];
  for (const row of trace.rows) {
    events.push(...suite.push(row, limitAt(trace.limits, row.ts), ctx));
  }
  events.push(...suite.flush());

  const base = trace.rows[0]?.ts ?? 0;
  const noEvents =
    trace.noEvents && events.length > 0
      ? [`expected no events at all; ${events.length} turned up: ${list(events, base)}`]
      : [];
  const failures = [
    ...noEvents,
    ...trace.expected.flatMap((exp) => checkExpectation(exp, events, base)),
    // Every line carries the trace it came from: the suite runs one test per fixture, but the
    // failures land in a shared report and "phone +60 s" alone does not say which drive.
  ].map((line) => `${trace.name}: ${line}`);
  return { events, passes: failures.length === 0, failures };
}
