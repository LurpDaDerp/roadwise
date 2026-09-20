// De-duplication (§9.3): overlapping detections of the same moment become one event in the
// heavier category, carrying the higher confidence and the union of the two spans.
import { CATEGORY } from '@scoring';
import type { EventCategory } from '@scoring';
import type { DetectedEvent } from '../engine/types';
import { alertableFor } from './common';

const MERGEABLE: ReadonlySet<EventCategory> = new Set<EventCategory>(['phone', 'focus']);

const endOf = (e: DetectedEvent): number => e.startedAt + e.durationS * 1000;

/** Closed intervals: sharing an instant is enough to be "the same moment". */
const overlaps = (a: DetectedEvent, b: DetectedEvent): boolean =>
  a.startedAt <= endOf(b) && b.startedAt <= endOf(a);

/** Phone with phone, or phone with camera focus. Two focus events are two glances and stay apart. */
const mergeable = (a: DetectedEvent, b: DetectedEvent): boolean =>
  MERGEABLE.has(a.category) &&
  MERGEABLE.has(b.category) &&
  (a.category === 'phone' || b.category === 'phone');

/** Which event's identity survives: the heavier category, then the higher q, then the earlier start. */
function rank(a: DetectedEvent, b: DetectedEvent): [kept: DetectedEvent, other: DetectedEvent] {
  const baseDiff = CATEGORY[a.category].base - CATEGORY[b.category].base;
  if (baseDiff !== 0) return baseDiff > 0 ? [a, b] : [b, a];
  if (a.q !== b.q) return a.q > b.q ? [a, b] : [b, a];
  return a.startedAt <= b.startedAt ? [a, b] : [b, a];
}

function mergePair(a: DetectedEvent, b: DetectedEvent): DetectedEvent {
  const [kept, other] = rank(a, b);
  const startedAt = Math.min(a.startedAt, b.startedAt);
  const durationS = (Math.max(endOf(a), endOf(b)) - startedAt) / 1000;
  const q = Math.max(a.q, b.q);
  return {
    ...kept,
    startedAt,
    durationS,
    q,
    source: a.source === b.source ? a.source : 'both',
    measured: { ...other.measured, ...kept.measured },
    alertable: alertableFor(kept.status, q),
  };
}

function findPair(
  events: DetectedEvent[]
): { i: number; j: number; a: DetectedEvent; b: DetectedEvent } | null {
  for (const [i, a] of events.entries()) {
    for (const [j, b] of events.entries()) {
      if (j > i && mergeable(a, b) && overlaps(a, b)) return { i, j, a, b };
    }
  }
  return null;
}

/** Collapse overlapping phone/focus detections; everything else passes through. Sorted by start. */
export function mergeEvents(events: DetectedEvent[]): DetectedEvent[] {
  const out = [...events];
  for (let pair = findPair(out); pair; pair = findPair(out)) {
    out[pair.i] = mergePair(pair.a, pair.b);
    out.splice(pair.j, 1);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
