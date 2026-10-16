// "A new phone was paired with your DashPal" (pairing v2 §9.8): a phone count that rises without
// this phone having caused it is shown once. Every count here comes from the authenticated link (a
// sealed STATUS or PAIRED), so nothing unproven can raise or clear the notice.
//
// This phone causes a rise by its own setup (the count it saw then is adopted) or by its own Add
// another phone in the last 3 min. The record follows every count, falls included; a first count,
// or a count for another DashPal, is adopted silently. Forget and a new pairing start it over. Kept
// in SQLite settings under `dashcam.lastPhones`, which the account handover keeps with the pairing.
import { isDashcamId } from './protocol';

/** This phone's own Add another phone explains a rise for this long. */
export const OWN_ADD_MS = 3 * 60_000;

export interface PhonesRecord {
  dashcamId: string;
  /** the last count seen */
  count: number;
  /** until then a rise is this phone's own Add another phone */
  ownUntil: number;
  /** the notice is waiting to be dismissed */
  notice: boolean;
}

export type PhonesEvent =
  /** a count from the link (STATUS or PAIRED) */
  | { kind: 'count'; dashcamId: string; count: number; now: number }
  /** this phone's own setup saw this count */
  | { kind: 'own_setup'; dashcamId: string; count: number }
  /** this phone opened Add another phone */
  | { kind: 'own_add'; dashcamId: string; now: number }
  | { kind: 'dismiss' }
  /** forgotten, or a different DashPal paired */
  | { kind: 'reset' };

export function nextPhones(rec: PhonesRecord | null, e: PhonesEvent): PhonesRecord | null {
  switch (e.kind) {
    case 'reset':
      return null;
    case 'dismiss':
      return rec ? { ...rec, notice: false } : null;
    case 'own_setup':
      return { dashcamId: e.dashcamId, count: e.count, ownUntil: rec?.dashcamId === e.dashcamId ? rec.ownUntil : 0, notice: false };
    case 'own_add':
      return rec && rec.dashcamId === e.dashcamId ? { ...rec, ownUntil: e.now + OWN_ADD_MS } : rec;
    case 'count': {
      if (!Number.isInteger(e.count) || e.count < 0) return rec;
      if (!rec || rec.dashcamId !== e.dashcamId) return { dashcamId: e.dashcamId, count: e.count, ownUntil: 0, notice: false };
      if (e.count === rec.count) return rec;
      const rise = e.count > rec.count;
      const own = e.now < rec.ownUntil && e.now >= rec.ownUntil - OWN_ADD_MS;
      return { ...rec, count: e.count, notice: rec.notice || (rise && !own) };
    }
  }
}

/** A stored value as a record, or null. */
export function asPhonesRecord(v: unknown): PhonesRecord | null {
  if (v === null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isDashcamId(r.dashcamId) || typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 0) return null;
  return {
    dashcamId: r.dashcamId,
    count: r.count,
    ownUntil: typeof r.ownUntil === 'number' && Number.isFinite(r.ownUntil) ? r.ownUntil : 0,
    notice: r.notice === true,
  };
}
