/**
 * The "Your commute" card's numbers (pure): the driver's drives between two saved places on the
 * commute legs (Home → Work, Work → Home, Home → School, School → Home, learned by
 * `@/core/places/commute`), each with its usual drive time, the time the driver usually leaves, its
 * score and how that score moved, and the problem spots most of its drives pass.
 */
import { commuteDrives, usualDeparture, type CommuteLegId, type CommutePlace, type UsualDeparture } from '@/core/places/commute';
import { HEADING_TOL_DEG, PASS_RADIUS_M } from '@/core/spots/constants';
import { angleDiffDeg } from '@/core/speedLimits/geometry';
import { isScoredDrive, type LocalDrive } from '@/data/queries/rows';
import type { ProblemSpot } from '@/data/queries/spots';
import { formatDuration, spokenDuration } from '@/features/drives/format';
import { bearingDeg, haversineMeters, type LatLng } from '@/lib/geo';
import { decodeRuns } from '@/lib/polyline';
import { cumulative, EXIT_MIN_M, exitAt, headingAt } from '@/lib/runs';

import { analyticsCopy } from './copy';

const DAY_MS = 86_400_000;

/** The card reads the drives of this many days back (its caption says "Last 4 months")… */
export const COMMUTE_CARD_DAYS = 120;
/** …and shows a leg with at least this many of them. */
export const COMMUTE_MIN_LEG_DRIVES = 3;
/** A leg's score is the mean of its newest this many scored drives… */
export const COMMUTE_SCORE_DRIVES = 5;
/** …and its change is against the mean of the same number before them, shown from this many scored drives on… */
export const COMMUTE_CHANGE_MIN_DRIVES = 8;
/** …as "Up" or "Down" from this many on (else "Steady"). */
export const COMMUTE_CHANGE_MIN = 2;
/** Scores are read for this many of a leg's newest drives: the two spans the score and its change take, and a few spare for drives with no score. */
export const COMMUTE_SCORE_READ_DRIVES = 2 * COMMUTE_SCORE_DRIVES + 4;
/** The sheet lists this many of the leg's newest drives. */
export const COMMUTE_RECENT_DRIVES = 3;
/** A spot is on the way when at least this share of the leg's drives with a route pass it… */
export const COMMUTE_SPOT_SHARE = 0.5;
/** …with the route within this many metres of its pin (the spots' own pass radius)… */
export const COMMUTE_SPOT_RADIUS_M = PASS_RADIUS_M;
/** …heading within this many degrees of its way (the spots' own tolerance). */
export const COMMUTE_SPOT_HEADING_DEG = HEADING_TOL_DEG;

/** One leg as the card reads it, before its scores. */
export interface CommuteLegData {
  id: CommuteLegId;
  from: CommutePlace;
  to: CommutePlace;
  /** The leg's drives in the window, newest first. */
  drives: LocalDrive[];
  /** The median drive time (s). */
  usualS: number;
  /** When the driver usually leaves (`usualDeparture`), or null when they don't keep to a time. */
  departure: UsualDeparture | null;
}

/** One row of the card: the leg and its score. */
export interface CommuteRow extends CommuteLegData {
  /** The rounded mean of the newest `COMMUTE_SCORE_DRIVES` scores; null while none is known. */
  score: number | null;
  /** The whole points the score moved against the drives before; null under `COMMUTE_CHANGE_MIN_DRIVES` scored drives. */
  change: number | null;
  /** How many of the leg's drives have a score. */
  scored: number;
}

/** The median of some numbers (the mean of the middle two for an even count); 0 for none. */
export function median(values: readonly number[]): number {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/** Rounded half away from zero, so a rise and a fall of the same size read the same (`Math.round(-2.5)` is -2). */
const roundAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/**
 * The commute legs the card shows, in `COMMUTE_LEGS` order: the scored drives not archived that
 * started in the last `COMMUTE_CARD_DAYS` days (up to `now`) and went from one saved place to
 * another (`commuteDrives`), each leg with at least `COMMUTE_MIN_LEG_DRIVES` of them, its median
 * drive time and its usual departure.
 */
export function commuteLegs(drives: readonly LocalDrive[], places: readonly CommutePlace[], now: number): CommuteLegData[] {
  if (places.length === 0) return [];
  const since = now - COMMUTE_CARD_DAYS * DAY_MS;
  const pool = drives.filter(
    (d) =>
      d.archived !== true &&
      isScoredDrive(d) &&
      Number.isFinite(d.startedAt) &&
      d.startedAt >= since &&
      d.startedAt <= now &&
      typeof d.fromPlace === 'string' &&
      typeof d.toPlace === 'string'
  );
  if (pool.length === 0) return [];
  return commuteDrives(pool, places)
    .filter((leg) => leg.drives.length >= COMMUTE_MIN_LEG_DRIVES)
    .map((leg) => {
      const list = [...leg.drives].sort((a, b) => b.startedAt - a.startedAt || a.clientTripId.localeCompare(b.clientTripId));
      return {
        id: leg.id,
        from: leg.from,
        to: leg.to,
        drives: list,
        usualS: median(list.map((d) => d.durationS)),
        departure: usualDeparture(list, now),
      };
    });
}

/**
 * A leg's score from its drives' scores (newest first; a drive with no score yet is skipped): the
 * rounded mean of the newest `COMMUTE_SCORE_DRIVES`, and, from `COMMUTE_CHANGE_MIN_DRIVES` scored
 * drives on, how far that mean moved from the mean of the (up to) `COMMUTE_SCORE_DRIVES` before them.
 */
export function legScore(drives: readonly LocalDrive[], scores: ReadonlyMap<string, number>): Pick<CommuteRow, 'score' | 'change' | 'scored'> {
  const list: number[] = [];
  for (const d of drives) {
    const s = scores.get(d.clientTripId);
    if (s !== undefined && Number.isFinite(s)) list.push(s);
  }
  if (list.length === 0) return { score: null, change: null, scored: 0 };
  const recent = mean(list.slice(0, COMMUTE_SCORE_DRIVES));
  const score = Math.round(recent);
  if (list.length < COMMUTE_CHANGE_MIN_DRIVES) return { score, change: null, scored: list.length };
  const before = mean(list.slice(COMMUTE_SCORE_DRIVES, 2 * COMMUTE_SCORE_DRIVES));
  // 0, never -0: a leg that held still reads "Steady" either way, but stays a plain 0 in the data.
  return { score, change: roundAway(recent - before) || 0, scored: list.length };
}

/** The drives whose scores the legs need: each leg's newest `COMMUTE_SCORE_READ_DRIVES`, so the read stays small and steady as old drives age out. */
export function scoreReadDrives(legs: readonly Pick<CommuteLegData, 'drives'>[]): LocalDrive[] {
  return legs.flatMap((l) => l.drives.slice(0, COMMUTE_SCORE_READ_DRIVES));
}

/** The card's rows: each leg with its score. */
export function commuteRows(legs: readonly CommuteLegData[], scores: ReadonlyMap<string, number>): CommuteRow[] {
  return legs.map((leg) => ({ ...leg, ...legScore(leg.drives, scores) }));
}

/** How many scores the leg's score is the mean of, and how many its change compares it with. */
export const scoreSpan = (scored: number): { recent: number; before: number } => ({
  recent: Math.min(COMMUTE_SCORE_DRIVES, scored),
  before: Math.max(0, Math.min(COMMUTE_SCORE_DRIVES, scored - COMMUTE_SCORE_DRIVES)),
});

/** Which way the score went: `null` with no change to show. */
export function changeKind(change: number | null): 'up' | 'down' | 'steady' | null {
  if (change === null) return null;
  if (Math.abs(change) < COMMUTE_CHANGE_MIN) return 'steady';
  return change > 0 ? 'up' : 'down';
}

/** A minute of the day on a 12-hour clock: 460 → "7:40 AM", 0 → "12:00 AM", 750 → "12:30 PM". */
export function clockOfMinute(minuteOfDay: number): string {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const period = h < 12 ? 'AM' : 'PM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${period}`;
}

// ── Words ───────────────────────────────────────────────────────────────────────────────

const c = analyticsCopy.commute;

/** "Up 3", "Down 2", "Steady"; null with no change to show. */
export function changeText(change: number | null): string | null {
  const kind = changeKind(change);
  if (kind === null || change === null) return null;
  return kind === 'steady' ? c.change.steady : c.change[kind](Math.abs(change));
}

/** A row's words: its title, its line ("Usually 24 min · Leave around 7:40 AM"), its score line ("Score 84 · Up 3"), and all of it for a screen reader. */
export function commuteText(row: CommuteRow): { title: string; line: string; score: string | null; spoken: string } {
  const title = c.leg(row.from.name, row.to.name);
  const leave = row.departure === null ? null : c.leave(clockOfMinute(row.departure.minuteOfDay));
  const line = [c.usually(formatDuration(row.usualS)), leave].filter((x): x is string => x !== null).join(' · ');
  const change = changeText(row.change);
  const score = row.score === null ? null : [c.score(row.score), change].filter((x): x is string => x !== null).join(' · ');
  const spoken = [c.spokenLeg(row.from.name, row.to.name), c.usually(spokenDuration(row.usualS)), leave, row.score === null ? null : c.score(row.score), change]
    .filter((x): x is string => x !== null)
    .join(', ');
  return { title, line, score, spoken };
}

// ── Spots on the way ────────────────────────────────────────────────────────────────────

/** The mean Earth radius `haversineMeters` uses, and metres per degree of latitude on it. */
const M_PER_DEG = (Math.PI / 180) * 6371008.8;

interface Run {
  points: LatLng[];
  /** Distance along the run, read the first time a point comes near a spot. */
  cum: number[] | null;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

function toRun(points: LatLng[]): Run {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { points, cum: null, minLat, maxLat, minLng, maxLng };
}

/** A drive's route as runs of at least two points; none when it holds no route. */
function routeOf(d: Pick<LocalDrive, 'polyline'>): Run[] {
  let runs: LatLng[][];
  try {
    runs = decodeRuns(d.polyline);
  } catch {
    return [];
  }
  return runs.filter((r) => r.length >= 2 && r.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))).map(toRun);
}

type OnTheWaySpot = Pick<ProblemSpot, 'state' | 'kind' | 'pin' | 'headingDeg' | 'segment'>;

/**
 * A sharp-turn spot's way out: the bearing from its pin to its coloured road's far end (which runs
 * the spots' 40 m exit past the pin). Null for other kinds, or when under 15 m of road follows the pin.
 */
function spotExit(spot: OnTheWaySpot): number | null {
  if (spot.kind !== 'hard_corner') return null;
  const end = spot.segment.length >= 2 ? spot.segment[spot.segment.length - 1] : undefined;
  if (end === undefined || !Number.isFinite(end.lat) || !Number.isFinite(end.lng) || !(haversineMeters(spot.pin, end) >= EXIT_MIN_M)) return null;
  return bearingDeg(spot.pin, end);
}

/**
 * Whether a route passes a spot: some stretch of it within `COMMUTE_SPOT_RADIUS_M` of the spot's
 * pin (a flat local frame, plenty at road scale) while heading within `COMMUTE_SPOT_HEADING_DEG` of
 * the spot's way and, at a sharp turn, leaving within as much of the turn's way out. The same test
 * the spots count their passes with, read at the pin.
 */
function passes(runs: readonly Run[], spot: OnTheWaySpot, exit: number | null): boolean {
  const p = spot.pin;
  const k = Math.cos((p.lat * Math.PI) / 180);
  const rLat = COMMUTE_SPOT_RADIUS_M / M_PER_DEG;
  const rLng = k > 0 ? rLat / k : rLat;
  const r2 = rLat * rLat;
  for (const run of runs) {
    if (p.lat < run.minLat - rLat || p.lat > run.maxLat + rLat || p.lng < run.minLng - rLng || p.lng > run.maxLng + rLng) continue;
    const pts = run.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if ((a.lat < p.lat - rLat && b.lat < p.lat - rLat) || (a.lat > p.lat + rLat && b.lat > p.lat + rLat)) continue;
      if ((a.lng < p.lng - rLng && b.lng < p.lng - rLng) || (a.lng > p.lng + rLng && b.lng > p.lng + rLng)) continue;
      const bx = (b.lng - a.lng) * k;
      const by = b.lat - a.lat;
      const px = (p.lng - a.lng) * k;
      const py = p.lat - a.lat;
      const len2 = bx * bx + by * by;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
      if ((px - t * bx) ** 2 + (py - t * by) ** 2 > r2) continue;
      run.cum ??= cumulative(pts);
      const cum = run.cum;
      const d = cum[i - 1]! + t * (cum[i]! - cum[i - 1]!);
      const h = headingAt(pts, cum, d);
      if (h === null || angleDiffDeg(h, spot.headingDeg) > COMMUTE_SPOT_HEADING_DEG) continue;
      if (exit !== null) {
        const e = exitAt(pts, cum, d);
        if (e === null || angleDiffDeg(e, exit) > COMMUTE_SPOT_HEADING_DEG) continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * The active spots on a leg's way, in the order given (the spots' rank): those at least
 * `COMMUTE_SPOT_SHARE` of the leg's drives that hold a route pass. None when no drive holds a route.
 */
export function spotsOnTheWay<S extends OnTheWaySpot>(spots: readonly S[], drives: readonly Pick<LocalDrive, 'polyline'>[]): S[] {
  const candidates = spots.filter((s) => s.state === 'active' && Number.isFinite(s.pin.lat) && Number.isFinite(s.pin.lng) && Number.isFinite(s.headingDeg));
  if (candidates.length === 0) return [];
  const routes = drives.map(routeOf).filter((runs) => runs.length > 0);
  if (routes.length === 0) return [];
  return candidates.filter((s) => {
    const exit = spotExit(s);
    let n = 0;
    for (const runs of routes) if (passes(runs, s, exit)) n += 1;
    return n > 0 && n >= COMMUTE_SPOT_SHARE * routes.length;
  });
}
