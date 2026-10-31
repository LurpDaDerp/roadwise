/**
 * Learned places: where this phone's drives start and end, and how likely each place is to be
 * home or a weekday place (work, school). Pure and on-device: it reads the raw first and last fix
 * the phone keeps for each drive (183 days, never uploaded) and nothing it works out leaves the
 * phone.
 *
 * - **Places.** Every drive's start and end is a point. Points are grouped around the densest
 *   ones first: a group takes every point within `CLUSTER_RADIUS_M` of its seed, its centre is the
 *   median of its points (so a stray fix can't drag it), and the points within that radius of the
 *   centre join too. Parking spots for one building land in one group; the house down the block
 *   (more than ~150 m away) is a group of its own.
 * - **Stays.** A drive that ends in a place and a next drive that starts in the same place make a
 *   stay there, from the one's end to the other's start. Stays are what tell home from work.
 * - **Nights.** Each local 03:00 inside the gap between two drives is a night. When both ends of
 *   the gap are the same place, the night is that place's; when they differ (a drive in between
 *   was not recorded), each place gets half. A long gap counts at most `MAX_NIGHTS_PER_GAP`.
 *   `pHome` is a place's share of all nights, shrunk toward 0 by one pseudo-night, so 3 nights out
 *   of 3 reads 0.75 and 20 of 21 reads 0.91.
 * - **Weekdays.** A stay with no 03:00 inside, 2.5 to 14 h long, at least 2 h of it between 06:00
 *   and 19:00, arriving Monday to Friday, is a weekday stay. Each place counts at most one per
 *   local day (a lunch break doesn't count twice). `pWork` is its share of all weekday stays,
 *   shrunk the same way.
 * - **Recency.** Every count used for a share is weighted by age, halving every `HALF_LIFE_DAYS`,
 *   so a month in a new home outweighs two months in the old one.
 * - **Accuracy gates.** A place is suggested only with `MIN_VISITS` visits on `MIN_DAYS`
 *   different days. It is "likely home" with `HOME_MIN_NIGHTS` nights and `pHome` of at least
 *   `HOME_MIN_P`, and "likely work or school" with `WORK_MIN_DAYS` weekday stays and `pWork` of at
 *   least `WORK_MIN_P`. Anything less is only a frequent place.
 */
import { haversineMeters, type LatLng } from '@/lib/geo';

export const CLUSTER_RADIUS_M = 150;
export const HALF_LIFE_DAYS = 30;
export const MIN_VISITS = 3;
export const MIN_DAYS = 2;
export const HOME_MIN_NIGHTS = 3;
export const HOME_MIN_P = 0.4;
export const WORK_MIN_DAYS = 3;
export const WORK_MIN_P = 0.3;
export const MAX_NIGHTS_PER_GAP = 3;
export const MAX_LEARNED = 12;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NIGHT_AT = 3 * HOUR;
const WORK_MIN_STAY = 2.5 * HOUR;
const WORK_MAX_STAY = 14 * HOUR;
const WORK_MIN_DAYTIME = 2 * HOUR;
const DAYTIME_FROM = 6 * HOUR;
const DAYTIME_TO = 19 * HOUR;

/** One drive's raw ends, as the phone stored them. */
export interface TripEnds {
  id: string;
  startedAt: number;
  endedAt: number;
  /** The drive's IANA time zone (local hours are read in it). */
  tz: string;
  start: LatLng | null;
  end: LatLng | null;
}

export type LearnedKind = 'home' | 'work' | 'frequent';

export interface LearnedPlace {
  /** The centre rounded to 4 dp, joined: stable while the place's points don't move. */
  id: string;
  center: LatLng;
  kind: LearnedKind;
  /** Visits (a stay is one visit, not two). */
  visits: number;
  /** Different local days with a start or end here. */
  days: number;
  /** Nights here (halves when the gap's two ends differ), unweighted. */
  nights: number;
  /** Nights anywhere, unweighted: what `nights` is out of. */
  nightsSeen: number;
  /** Weekday stays here (one per local day), unweighted. */
  weekdays: number;
  /** Recency-weighted share of every drive start and end, 0–1. */
  share: number;
  /** Recency-weighted chance this is where you spend the night, 0–1. */
  pHome: number;
  /** Recency-weighted chance this is your weekday place, 0–1. */
  pWork: number;
  /** The newest start or end here (ms). */
  lastSeen: number;
}

// ---------------------------------------------------------------- local time

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      formatters.set(
        tz,
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      );
    } catch {
      formatters.set(tz, null);
    }
  }
  return formatters.get(tz) ?? null;
}

/** Offsets by zone and hour: a zone's offset only changes on the hour (DST), and Intl is slow on a phone. */
const offsets = new Map<string, number>();

/** How far `tz`'s wall clock is ahead of UTC at `ts` (ms); the phone's own offset when `tz` is unknown. */
export function offsetMs(ts: number, tz: string): number {
  const key = `${tz}|${Math.floor(ts / HOUR)}`;
  const hit = offsets.get(key);
  if (hit !== undefined) return hit;
  if (offsets.size > 20_000) offsets.clear();
  const value = computeOffset(ts, tz);
  offsets.set(key, value);
  return value;
}

function computeOffset(ts: number, tz: string): number {
  const f = formatterFor(tz);
  if (f !== null) {
    try {
      const parts = f.formatToParts(new Date(ts));
      const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
      const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
      if (Number.isFinite(wall)) return Math.round((wall - (ts - (ts % 1000))) / 60_000) * 60_000;
    } catch {
      // fall through to the phone's own zone
    }
  }
  return -new Date(ts).getTimezoneOffset() * 60_000;
}

/** Local 03:00s after `fromLocal` up to and including `toLocal` (both local wall-clock ms). */
export function nightsBetween(fromLocal: number, toLocal: number): number {
  if (toLocal <= fromLocal) return 0;
  return Math.max(0, Math.floor((toLocal - NIGHT_AT) / DAY) - Math.floor((fromLocal - NIGHT_AT) / DAY));
}

/** Of a stay (local ms, no 03:00 inside), how long falls between 06:00 and 19:00 of the days it touches. */
export function daytimeMs(fromLocal: number, toLocal: number): number {
  let total = 0;
  for (let day = Math.floor(fromLocal / DAY); day <= Math.floor(toLocal / DAY); day += 1) {
    const a = Math.max(fromLocal, day * DAY + DAYTIME_FROM);
    const b = Math.min(toLocal, day * DAY + DAYTIME_TO);
    if (b > a) total += b - a;
  }
  return total;
}

const isWeekday = (local: number): boolean => {
  const d = new Date(local).getUTCDay();
  return d >= 1 && d <= 5;
};

// ---------------------------------------------------------------- grouping

const M_PER_DEG = 111_320;

/** A grid of points in ~radius-sized cells, for "every point within r of here". */
function grid(points: readonly LatLng[], radiusM: number) {
  const latCell = radiusM / M_PER_DEG;
  const lngCell = (row: number) => latCell / Math.max(0.05, Math.cos(((row + 0.5) * latCell * Math.PI) / 180));
  const cells = new Map<string, number[]>();
  const rowOf = (p: LatLng) => Math.floor(p.lat / latCell);
  const key = (row: number, col: number) => `${row}:${col}`;
  points.forEach((p, i) => {
    const row = rowOf(p);
    const k = key(row, Math.floor(p.lng / lngCell(row)));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  });
  return {
    within(center: LatLng, r: number): number[] {
      const out: number[] = [];
      const row0 = rowOf(center);
      for (let row = row0 - 1; row <= row0 + 1; row += 1) {
        const col0 = Math.floor(center.lng / lngCell(row));
        for (let col = col0 - 1; col <= col0 + 1; col += 1) {
          for (const i of cells.get(key(row, col)) ?? []) if (haversineMeters(center, points[i] as LatLng) <= r) out.push(i);
        }
      }
      return out;
    },
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const medianOf = (points: readonly LatLng[], idx: readonly number[]): LatLng => ({
  lat: median(idx.map((i) => (points[i] as LatLng).lat)),
  lng: median(idx.map((i) => (points[i] as LatLng).lng)),
});

/**
 * Groups `points`: densest first, each group every unclaimed point within `radiusM` of its seed,
 * then of its median centre. Returns each point's group and each group's centre.
 */
export function groupPoints(points: readonly LatLng[], radiusM: number = CLUSTER_RADIUS_M, order?: readonly number[]): { groupOf: number[]; centers: LatLng[] } {
  const g = grid(points, radiusM);
  const density = points.map((p) => g.within(p, radiusM).length);
  const seq = order ? [...order] : points.map((_, i) => i);
  seq.sort((a, b) => (density[b] as number) - (density[a] as number));
  const groupOf = points.map(() => -1);
  const centers: LatLng[] = [];
  for (const seed of seq) {
    if (groupOf[seed] !== -1) continue;
    const id = centers.length;
    let members = g.within(points[seed] as LatLng, radiusM).filter((i) => groupOf[i] === -1);
    let center = medianOf(points, members);
    members = [...new Set([...members, ...g.within(center, radiusM).filter((i) => groupOf[i] === -1)])];
    center = medianOf(points, members);
    for (const i of members) groupOf[i] = id;
    centers.push(center);
  }
  return { groupOf, centers };
}

// ---------------------------------------------------------------- learning

interface Acc {
  visits: number;
  days: Set<number>;
  nights: number;
  nightsW: number;
  weekdayDays: Map<number, number>;
  endsW: number;
  lastSeen: number;
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * The places these drives start and end at, most visited first (`MAX_LEARNED` at most), each with
 * its chance of being home or the weekday place. Only places that pass `MIN_VISITS` on `MIN_DAYS`.
 */
export function learnPlaces(trips: readonly TripEnds[], now: number): LearnedPlace[] {
  const sorted = trips.filter((t) => Number.isFinite(t.startedAt) && Number.isFinite(t.endedAt) && t.endedAt >= t.startedAt).sort((a, b) => a.startedAt - b.startedAt);
  const weight = (ts: number) => Math.pow(0.5, Math.max(0, now - ts) / (HALF_LIFE_DAYS * DAY));

  // Every start and end, as points.
  const points: LatLng[] = [];
  const at: { ts: number; tz: string }[] = [];
  const startIdx = new Map<number, number>();
  const endIdx = new Map<number, number>();
  const ok = (p: LatLng | null): p is LatLng => p !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  sorted.forEach((t, k) => {
    if (ok(t.start)) {
      startIdx.set(k, points.length);
      points.push(t.start);
      at.push({ ts: t.startedAt, tz: t.tz });
    }
    if (ok(t.end)) {
      endIdx.set(k, points.length);
      points.push(t.end);
      at.push({ ts: t.endedAt, tz: t.tz });
    }
  });
  if (points.length === 0) return [];

  // Newest first breaks density ties, so a place's newest parking spot seeds it.
  const order = points.map((_, i) => i).sort((a, b) => (at[b] as { ts: number }).ts - (at[a] as { ts: number }).ts);
  const { groupOf, centers } = groupPoints(points, CLUSTER_RADIUS_M, order);
  const acc: Acc[] = centers.map(() => ({ visits: 0, days: new Set(), nights: 0, nightsW: 0, weekdayDays: new Map(), endsW: 0, lastSeen: 0 }));

  let endsW = 0;
  points.forEach((_, i) => {
    const a = acc[groupOf[i] as number] as Acc;
    const { ts, tz } = at[i] as { ts: number; tz: string };
    const w = weight(ts);
    a.endsW += w;
    endsW += w;
    a.visits += 1;
    a.days.add(Math.floor((ts + offsetMs(ts, tz)) / DAY));
    a.lastSeen = Math.max(a.lastSeen, ts);
  });

  // Gaps between one drive's end and the next drive's start.
  let nightsSeen = 0;
  let nightsW = 0;
  let weekdaysW = 0;
  for (let k = 0; k + 1 < sorted.length; k += 1) {
    const ei = endIdx.get(k);
    const si = startIdx.get(k + 1);
    if (ei === undefined || si === undefined) continue;
    const from = (sorted[k] as TripEnds).endedAt;
    const to = (sorted[k + 1] as TripEnds).startedAt;
    if (to <= from) continue;
    const off = offsetMs(from, (sorted[k] as TripEnds).tz);
    const fromLocal = from + off;
    const toLocal = to + off;
    const ge = groupOf[ei] as number;
    const gs = groupOf[si] as number;
    const same = ge === gs;
    // A stay is one visit, not an arrival and a departure.
    if (same) (acc[ge] as Acc).visits -= 1;
    const n = Math.min(MAX_NIGHTS_PER_GAP, nightsBetween(fromLocal, toLocal));
    const w = weight(to);
    if (n > 0) {
      nightsSeen += n;
      nightsW += n * w;
      for (const g of same ? [ge] : [ge, gs]) {
        const share = same ? 1 : 0.5;
        (acc[g] as Acc).nights += n * share;
        (acc[g] as Acc).nightsW += n * share * w;
      }
      continue;
    }
    if (!same) continue;
    const stay = to - from;
    if (stay < WORK_MIN_STAY || stay > WORK_MAX_STAY || !isWeekday(fromLocal)) continue;
    if (daytimeMs(fromLocal, toLocal) < WORK_MIN_DAYTIME) continue;
    const day = Math.floor(fromLocal / DAY);
    const days = (acc[ge] as Acc).weekdayDays;
    if (!days.has(day)) {
      days.set(day, w);
      weekdaysW += w;
    }
  }

  const out: LearnedPlace[] = [];
  acc.forEach((a, g) => {
    const weekdays = a.weekdayDays.size;
    const weekdayW = [...a.weekdayDays.values()].reduce((s, w) => s + w, 0);
    const pHome = a.nightsW / (nightsW + 1);
    const pWork = weekdayW / (weekdaysW + 1);
    const home = a.nights >= HOME_MIN_NIGHTS && pHome >= HOME_MIN_P;
    const work = !home && weekdays >= WORK_MIN_DAYS && pWork >= WORK_MIN_P;
    if (!home && !work && (a.visits < MIN_VISITS || a.days.size < MIN_DAYS)) return;
    const c = centers[g] as LatLng;
    out.push({
      id: `${round4(c.lat)},${round4(c.lng)}`,
      center: c,
      kind: home ? 'home' : work ? 'work' : 'frequent',
      visits: a.visits,
      days: a.days.size,
      nights: a.nights,
      nightsSeen,
      weekdays,
      share: endsW > 0 ? a.endsW / endsW : 0,
      pHome,
      pWork,
      lastSeen: a.lastSeen,
    });
  });
  return out.sort((a, b) => b.share - a.share || b.lastSeen - a.lastSeen).slice(0, MAX_LEARNED);
}

// ---------------------------------------------------------------- suggestions

export type PlaceSlot = 'home' | 'work' | 'school' | 'custom';

/** A learned place this close to a saved one is that place: it isn't suggested again. */
export const SAVED_NEAR_M = 200;
export const MAX_SUGGESTIONS = 3;

/**
 * The learned places worth offering for `slot`, best first: for Home the likeliest night place,
 * for Work and School the likeliest weekday place (never a likely home), for any other place the
 * most visited. Places already saved (`taken`) are left out; a place that fits the slot at all
 * comes before one that is only frequent.
 */
export function suggestionsFor(slot: PlaceSlot, learned: readonly LearnedPlace[], taken: readonly LatLng[]): LearnedPlace[] {
  const free = learned.filter((p) => taken.every((t) => haversineMeters(t, p.center) > SAVED_NEAR_M));
  const ranked =
    slot === 'home'
      ? [...free].sort((a, b) => rankHome(b) - rankHome(a) || b.share - a.share)
      : slot === 'custom'
        ? [...free].sort((a, b) => b.share - a.share)
        : free.filter((p) => p.kind !== 'home').sort((a, b) => rankWork(b) - rankWork(a) || b.share - a.share);
  return ranked.slice(0, MAX_SUGGESTIONS);
}

const rankHome = (p: LearnedPlace): number => (p.kind === 'home' ? 2 : 0) + p.pHome;
const rankWork = (p: LearnedPlace): number => (p.kind === 'work' ? 2 : 0) + p.pWork;
