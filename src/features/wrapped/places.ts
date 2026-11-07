/**
 * The own Wrapped's Places slide (pure), read from this phone's drives and never sent anywhere: the
 * month's most-driven trip (the from → to labels of its scored drives, 2 drives or more, labels
 * known; a tie goes to the one driven most recently), and how many of the month's drives were on a
 * commute leg (Home ↔ Work, Home ↔ School: `commuteDrives`).
 */
import { commuteDrives, type CommutePlace } from '@/core/places/commute';
import { isScoredDrive, type LocalDrive } from '@/data/queries/rows';

import { monthOf } from './month';

/** The fewest drives that make a trip "most driven". */
export const PLACES_MIN_DRIVES = 2;

export interface WrappedPlaces {
  /** The most-driven trip, or null when no trip was driven twice. */
  pair: { from: string; to: string; drives: number } | null;
  /** The month's drives on a commute leg. */
  commuteDrives: number;
}

type PlacesDrive = Pick<LocalDrive, 'clientTripId' | 'startedAt' | 'status' | 'reason' | 'archived' | 'fromLabel' | 'toLabel' | 'fromPlace' | 'toPlace' | 'start' | 'end' | 'tz'>;

/** The month's drives: scored, not archived, started on a local day of `month` (in the drive's own zone). */
export function monthDrives<T extends PlacesDrive>(drives: readonly T[], month: string): T[] {
  return drives.filter((d) => d.archived !== true && isScoredDrive(d) && Number.isFinite(d.startedAt) && monthOf(d.startedAt, d.tz) === month);
}

export function wrappedPlaces(drives: readonly PlacesDrive[], month: string, places: readonly CommutePlace[]): WrappedPlaces {
  const mine = monthDrives(drives, month);
  const trips = new Map<string, { from: string; to: string; drives: number; last: number }>();
  for (const d of mine) {
    const from = d.fromLabel?.trim();
    const to = d.toLabel?.trim();
    if (!from || !to) continue;
    const key = `${from}\u0000${to}`;
    const t = trips.get(key) ?? { from, to, drives: 0, last: -Infinity };
    t.drives += 1;
    t.last = Math.max(t.last, d.startedAt);
    trips.set(key, t);
  }
  let best: { from: string; to: string; drives: number; last: number } | null = null;
  for (const t of trips.values()) {
    if (t.drives < PLACES_MIN_DRIVES) continue;
    if (best === null || t.drives > best.drives || (t.drives === best.drives && t.last > best.last)) best = t;
  }
  const commute = places.length === 0 ? 0 : commuteDrives(mine, places).reduce((n, leg) => n + leg.drives.length, 0);
  return { pair: best === null ? null : { from: best.from, to: best.to, drives: best.drives }, commuteDrives: commute };
}
