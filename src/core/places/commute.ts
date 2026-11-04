/**
 * The driver's commute, learned from their own drives (pure). A commute leg is a drive from one
 * saved place to another of Home → Work, Work → Home, Home → School and School → Home, read from
 * the saved places each drive started and ended at (`from_place` / `to_place`, exact matches made
 * when it was stored). The usual departure on a leg is the median local start time of its recent
 * weekday drives, and only when they keep to it: enough drives, on enough days, over more than one
 * week, most of them within `COMMUTE_SPREAD_MIN` of it. Used by the Analytics commute card and the
 * weather heads-up before the usual departure.
 */
import { haversineMeters, type LatLng } from '@/lib/geo';

import { offsetMs } from './learn';
import type { FixedKind, SavedPlace } from './saved';

/** The legs, in the order they're shown. */
export const COMMUTE_LEGS = [
  { id: 'home-work', from: 'home', to: 'work' },
  { id: 'work-home', from: 'work', to: 'home' },
  { id: 'home-school', from: 'home', to: 'school' },
  { id: 'school-home', from: 'school', to: 'home' },
] as const satisfies readonly { id: string; from: FixedKind; to: FixedKind }[];
export type CommuteLegId = (typeof COMMUTE_LEGS)[number]['id'];

/** The usual departure reads the leg's drives of this many days back… */
export const COMMUTE_WINDOW_DAYS = 42;
/** …started Monday to Friday (in each drive's own time zone)… */
export const COMMUTE_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
/** …at least this many of them… */
export const COMMUTE_MIN_DRIVES = 4;
/** …on at least this many different days… */
export const COMMUTE_MIN_DAYS = 4;
/** …spread over at least this many different weeks (Monday to Sunday)… */
export const COMMUTE_MIN_WEEKS = 2;
/** …with at least this share of them… */
export const COMMUTE_CONSISTENT_SHARE = 0.6;
/** …started within this many minutes of the median start. */
export const COMMUTE_SPREAD_MIN = 45;
/**
 * A drive whose stored start (end) lies farther than this from the saved place it was matched to
 * was matched to where that place used to be (the place has since moved: a new home): it is not on
 * the leg. The farthest an exact match reaches is 150 m (`PLACE_ADDRESS_MAX_M`), plus the stored
 * points' rounding.
 */
export const COMMUTE_MOVED_M = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

/** What the learner reads of a drive. */
export interface CommuteDrive {
  startedAt: number;
  /** The drive's IANA time zone; absent or unknown: the phone's own. */
  tz?: string | null;
  fromPlace?: string | null;
  toPlace?: string | null;
  /** Where it started and ended, when the phone keeps them (the moved-place check). */
  start?: LatLng | null;
  end?: LatLng | null;
}

/** What the learner reads of a saved place. */
export type CommutePlace = Pick<SavedPlace, 'id' | 'kind' | 'name' | 'lat' | 'lng'>;

export interface CommuteLeg<T extends CommuteDrive> {
  id: CommuteLegId;
  from: CommutePlace;
  to: CommutePlace;
  /** The leg's drives, in the order given. */
  drives: T[];
}

const awayFrom = (point: LatLng | null | undefined, place: CommutePlace): boolean =>
  point !== null && point !== undefined && Number.isFinite(point.lat) && Number.isFinite(point.lng) && haversineMeters(point, place) > COMMUTE_MOVED_M;

/**
 * The drives on each commute leg whose two places are saved, in `COMMUTE_LEGS` order; a leg with
 * no drive is left out. A drive is on a leg when its start place is the leg's from place and its end
 * place the leg's to place (by id, resolved to the saved place and its kind), and neither of its
 * stored points is more than `COMMUTE_MOVED_M` from that place (it went to where the place used to be).
 */
export function commuteDrives<T extends CommuteDrive>(drives: readonly T[], places: readonly CommutePlace[]): CommuteLeg<T>[] {
  const byId = new Map(places.map((p) => [p.id, p] as const));
  const out: CommuteLeg<T>[] = [];
  for (const leg of COMMUTE_LEGS) {
    const from = places.find((p) => p.kind === leg.from);
    const to = places.find((p) => p.kind === leg.to);
    if (!from || !to) continue;
    const on = drives.filter((d) => {
      if (typeof d.fromPlace !== 'string' || typeof d.toPlace !== 'string') return false;
      if (byId.get(d.fromPlace) !== from || byId.get(d.toPlace) !== to) return false;
      return !awayFrom(d.start, from) && !awayFrom(d.end, to);
    });
    if (on.length > 0) out.push({ id: leg.id, from, to, drives: on });
  }
  return out;
}

/** The drive's start on its own local wall clock: the day (days since 1970-01-01), the weekday (0 Sunday) and the minute of the day. */
function localStart(d: CommuteDrive): { day: number; weekday: number; minute: number } {
  const local = d.startedAt + offsetMs(d.startedAt, typeof d.tz === 'string' ? d.tz : '');
  const day = Math.floor(local / DAY_MS);
  return { day, weekday: new Date(day * DAY_MS).getUTCDay(), minute: Math.floor((local - day * DAY_MS) / 60_000) };
}

/** The Monday-to-Sunday week a local day falls in (1970-01-01 was a Thursday). */
const weekOf = (day: number): number => Math.floor((day + 3) / 7);

/** How far apart two minutes of the day are, around midnight too. */
export const minutesApart = (a: number, b: number): number => {
  const d = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(d, MINUTES_PER_DAY - d);
};

/**
 * The median of minutes of the day, read around the clock: cut at the widest gap between them, so
 * 23:50 and 00:10 are 20 minutes apart (their median is midnight), not 23 h 40 min. Rounded.
 */
export function medianMinute(minutes: readonly number[]): number {
  const s = [...minutes].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  // The widest gap: after s[i], up to the next one around the clock.
  let cut = n - 1;
  let widest = (s[0] as number) + MINUTES_PER_DAY - (s[n - 1] as number);
  for (let i = 0; i < n - 1; i += 1) {
    const gap = (s[i + 1] as number) - (s[i] as number);
    if (gap > widest) {
      widest = gap;
      cut = i;
    }
  }
  // Unwrapped: the run after the widest gap, then the one before it a day later.
  const line = [...s.slice(cut + 1), ...s.slice(0, cut + 1).map((m) => m + MINUTES_PER_DAY)];
  const mid = n >> 1;
  const median = n % 2 === 1 ? (line[mid] as number) : ((line[mid - 1] as number) + (line[mid] as number)) / 2;
  return Math.round(median) % MINUTES_PER_DAY;
}

/** The usual departure on a leg: the local minute of the day, and how many drives it was read from. */
export interface UsualDeparture {
  minuteOfDay: number;
  drives: number;
}

/**
 * When the driver usually leaves on a leg, from its drives started in the last
 * `COMMUTE_WINDOW_DAYS` days (up to `now`) on a weekday in each drive's own time zone: at least
 * `COMMUTE_MIN_DRIVES` of them on `COMMUTE_MIN_DAYS` different days over `COMMUTE_MIN_WEEKS`
 * different weeks, their median local start (`medianMinute`), and only when at least
 * `COMMUTE_CONSISTENT_SHARE` of them started within `COMMUTE_SPREAD_MIN` of it. Else null.
 */
export function usualDeparture(legDrives: readonly CommuteDrive[], now: number): UsualDeparture | null {
  const since = now - COMMUTE_WINDOW_DAYS * DAY_MS;
  const starts = legDrives
    .filter((d) => Number.isFinite(d.startedAt) && d.startedAt >= since && d.startedAt <= now)
    .map(localStart)
    .filter((s) => COMMUTE_WEEKDAYS.includes(s.weekday));
  if (starts.length < COMMUTE_MIN_DRIVES) return null;
  if (new Set(starts.map((s) => s.day)).size < COMMUTE_MIN_DAYS) return null;
  if (new Set(starts.map((s) => weekOf(s.day))).size < COMMUTE_MIN_WEEKS) return null;
  const minutes = starts.map((s) => s.minute);
  const usual = medianMinute(minutes);
  const close = minutes.filter((m) => minutesApart(m, usual) <= COMMUTE_SPREAD_MIN).length;
  // At least the share, in whole numbers (60 % of 5 is 3, never 2.9999…).
  if (close * 100 < Math.round(COMMUTE_CONSISTENT_SHARE * 100) * starts.length) return null;
  return { minuteOfDay: usual, drives: starts.length };
}
