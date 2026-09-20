// The per-event columns the server derives itself before anything is stored (§4.7: never a
// client-supplied derived value). The device sends `severity`, `contextMultiplier` and
// `deduction` beside each event because its own row needs them; the server recomputes all three
// from the event's inputs with the same package, so what `apply_trip` stores is what the score
// was actually built from.
import { CONSTANTS, contextMultiplier, severity } from './scoring/index';
import type { ScoredTrip } from './scoring/index';
import type { PayloadEvent } from './payload.ts';

/** Every event with the server's `severity`, `contextMultiplier` and `deduction`; inputs untouched. */
export function deriveEvents(events: readonly PayloadEvent[], scored: ScoredTrip): PayloadEvent[] {
  return events.map((e) => ({
    ...e,
    severity: severity(e),
    contextMultiplier: contextMultiplier(e),
    deduction: scored.status === 'final' ? (scored.eventDeductions[e.id] ?? 0) : null,
  }));
}

/**
 * The half of `hadSevereEvent` the server can check (§9.9): a scored speeding event at or beyond
 * `SEVERE_SPEEDING_OVER_MPS`. An L3 alert is the other half and only the device knows it, so the
 * stored flag is the device's OR this.
 */
export function hasSevereSpeeding(events: readonly PayloadEvent[]): boolean {
  return events.some(
    (e) =>
      e.category === 'speeding' &&
      e.status === 'scored' &&
      (e.measured.overMps ?? 0) >= CONSTANTS.SEVERE_SPEEDING_OVER_MPS
  );
}

/** How many events' derived numbers the device got wrong (beyond float noise), for the log. */
export function countDerivedDrift(sent: readonly PayloadEvent[], derived: readonly PayloadEvent[]): number {
  let n = 0;
  for (let i = 0; i < sent.length; i += 1) {
    const a = sent[i];
    const b = derived[i];
    const off = (x: number | null, y: number | null) =>
      x === null || y === null ? x !== y : Math.abs(x - y) > 1e-6;
    if (off(a.severity, b.severity) || off(a.contextMultiplier, b.contextMultiplier) || off(a.deduction, b.deduction)) {
      n += 1;
    }
  }
  return n;
}
