/**
 * Pure view logic for the Leagues tab: zones, the countdown, rating text, the friends board order
 * and last week's result. No React, no clock: callers pass `now`.
 */
import { formatRating } from '@/lib/rating';
import { TIER_LABEL, TIER_ORDER } from '@/ui';

import type { FriendsBoardRow, FriendsMetric, LeagueMember, LeagueTier, MyLeague } from './api';

// ---------------------------------------------------------------------------
// zones
// ---------------------------------------------------------------------------

export type Zone = 'up' | 'stay' | 'down';

/**
 * Where a rank sits when the week closes, mirroring `private.close_leagues`: the top `promote`
 * move up (not from Diamond), and anyone outside the top `promote` in the bottom `demote` of the
 * group moves down (not from Bronze). The drive minimum is shown separately.
 */
export function leagueZone(
  rank: number,
  league: Pick<MyLeague, 'tier' | 'size' | 'promote' | 'demote'>
): Zone {
  const idx = TIER_ORDER.indexOf(league.tier);
  if (rank <= league.promote && idx < TIER_ORDER.length - 1) return 'up';
  if (rank > league.promote && rank > league.size - league.demote && idx > 0) return 'down';
  return 'stay';
}

export type BoardItem =
  | {
      kind: 'row';
      member: LeagueMember;
      /** What the row shows: a top spot short of the drive minimum is not marked "moves up". */
      zone: Zone;
      /** Drives still needed for a top spot to count (0 otherwise). */
      needs: number;
    }
  | { kind: 'divider'; zone: 'up' | 'down' };

/**
 * The league standings with the two zone lines: "Moves up" under the top spots and "Moves down"
 * above the first demoted row. The lines follow rank alone; a row only shows "moves up" when it
 * also has the week's minimum drives, as the Monday close requires. A line only appears with rows
 * on both sides of it.
 */
export function leagueBoardItems(league: MyLeague): BoardItem[] {
  const rows = league.members.map((member) => {
    const place = leagueZone(member.rank, league);
    const needs = place === 'up' ? drivesToMoveUp(member.drives, league.min_drives_to_promote) : 0;
    const zone: Zone = needs > 0 ? 'stay' : place;
    return { member, place, zone, needs };
  });
  const items: BoardItem[] = [];
  rows.forEach(({ member, place, zone, needs }, i) => {
    const prev = rows[i - 1];
    if (place === 'down' && prev && prev.place !== 'down') items.push({ kind: 'divider', zone: 'down' });
    items.push({ kind: 'row', member, zone, needs });
    const next = rows[i + 1];
    if (place === 'up' && next && next.place !== 'up') items.push({ kind: 'divider', zone: 'up' });
  });
  return items;
}

/** "needs 2 more drives" under a top spot that doesn't count yet. */
export function needsDrivesText(needs: number): string {
  return `needs ${needs} more ${needs === 1 ? 'drive' : 'drives'}`;
}

/** Drives still needed this week before a top spot counts as moving up. */
export function drivesToMoveUp(drives: number, minDrives: number): number {
  return Math.max(0, minDrives - drives);
}

export function nextTier(tier: LeagueTier): LeagueTier | null {
  return TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] ?? null;
}

export function previousTier(tier: LeagueTier): LeagueTier | null {
  const idx = TIER_ORDER.indexOf(tier);
  return idx > 0 ? (TIER_ORDER[idx - 1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// countdown
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parts(endsAtMs: number, nowMs: number): { d: number; h: number; m: number } | null {
  const left = endsAtMs - nowMs;
  if (!(left > 0)) return null;
  return { d: Math.floor(left / DAY), h: Math.floor((left % DAY) / HOUR), m: Math.floor((left % HOUR) / MINUTE) };
}

/** "Ends in 2d 4h" · "Ends in 3h 12m" · "Ends in 5m" · "Ending now". Minute resolution. */
export function formatEndsIn(endsAtMs: number, nowMs: number): string {
  const p = parts(endsAtMs, nowMs);
  if (!p) return 'Ending now';
  if (p.d > 0) return `Ends in ${p.d}d ${p.h}h`;
  if (p.h > 0) return `Ends in ${p.h}h ${p.m}m`;
  return `Ends in ${Math.max(1, p.m)}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The same countdown in words, for screen readers. */
export function endsInLabel(endsAtMs: number, nowMs: number): string {
  const p = parts(endsAtMs, nowMs);
  if (!p) return 'League week is ending now';
  if (p.d > 0) return `League week ends in ${plural(p.d, 'day')} ${plural(p.h, 'hour')}`;
  if (p.h > 0) return `League week ends in ${plural(p.h, 'hour')} ${plural(p.m, 'minute')}`;
  return `League week ends in ${plural(Math.max(1, p.m), 'minute')}`;
}

/** Milliseconds until the next whole minute, so a minute clock ticks on the minute. */
export function msToNextMinute(nowMs: number): number {
  return MINUTE - (nowMs % MINUTE);
}

// ---------------------------------------------------------------------------
// numbers and words
// ---------------------------------------------------------------------------

export { UNRANKED } from '@/lib/rating';

/** A Safety Rating, never shown for an unranked driver (under 25 mi in 30 days): the shared rule. */
export const ratingText = (rating: number | null, ranked: boolean): string => formatRating(rating, ranked);

export function percentileText(percentile: number): string {
  return `You're in the top ${percentile}%`;
}

export function rankText(rank: number): string {
  return `#${rank.toLocaleString('en-US')}`;
}

export interface RankedFriendRow extends Omit<FriendsBoardRow, 'rank'> {
  /** Null for an unranked driver on the rating board: they are listed, not placed. */
  rank: number | null;
}

/**
 * The friends & clan board as shown. Week points keep the server's order. On the rating board an
 * unranked driver's number is a few miles of noise, so ranked drivers come first by rating (ties
 * by username, as the server does) and unranked ones follow, alphabetical, with no place.
 */
export function rankFriendsBoard(rows: readonly FriendsBoardRow[], metric: FriendsMetric): RankedFriendRow[] {
  if (metric === 'week') return [...rows].sort((a, b) => a.rank - b.rank);
  const byName = (a: FriendsBoardRow, b: FriendsBoardRow) => a.username.localeCompare(b.username);
  const ranked = rows
    .filter((r) => r.ranked && r.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || byName(a, b))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const unranked = rows
    .filter((r) => !(r.ranked && r.value !== null))
    .sort(byName)
    .map((r) => ({ ...r, rank: null }));
  return [...ranked, ...unranked];
}

// ---------------------------------------------------------------------------
// last week
// ---------------------------------------------------------------------------

/** ISO weeks in an ISO year: 53 when Dec 28 (always in the last week) falls in week 53. */
function isoWeeksInYear(year: number): number {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  const day = (dec28.getUTCDay() + 6) % 7; // Mon = 0
  const thursday = new Date(dec28.getTime() + (3 - day) * DAY);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / DAY / 7) + 1;
}

/** The week key before `week` ("2026-W01" → "2025-W52" or "-W53"). */
export function previousWeekKey(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return '';
  const year = Number(m[1]);
  const w = Number(m[2]);
  if (w > 1) return `${year}-W${String(w - 1).padStart(2, '0')}`;
  return `${year - 1}-W${String(isoWeeksInYear(year - 1)).padStart(2, '0')}`;
}

/**
 * Last week's result line, or null when the newest result is older than last week (someone who
 * skipped a week doesn't keep seeing a stale banner).
 */
export function lastResultText(league: Pick<MyLeague, 'week' | 'last_result'>): string | null {
  const r = league.last_result;
  if (!r || r.week !== previousWeekKey(league.week)) return null;
  const place = `You finished ${rankText(r.final_rank)} last week`;
  if (r.result === 'promoted') {
    const to = nextTier(r.tier);
    return `${place} and moved up to ${TIER_LABEL[to ?? r.tier]}!`;
  }
  if (r.result === 'demoted') {
    const to = previousTier(r.tier);
    return `${place} and moved down to ${TIER_LABEL[to ?? r.tier]}. New week, fresh start.`;
  }
  return `${place} and stayed in ${TIER_LABEL[r.tier]}.`;
}
