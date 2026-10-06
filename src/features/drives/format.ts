/**
 * Pure formatting for the drive screens: dates, distances, points, event names and the weekly
 * grouping of the history. No React, no theme — every rule is testable on its own.
 */
import type { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';

import { formatPointsValue, type Signal } from '@/ui';

import type { LocalDrive } from './model';

type IconName = keyof typeof Ionicons.glyphMap;

function fmt(ts: number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', options).format(new Date(ts));
}

/** "Mon, Oct 5". */
export const formatDay = (ts: number): string => fmt(ts, { weekday: 'short', month: 'short', day: 'numeric' });

/** "7:42 AM". */
export const formatClock = (ts: number): string => fmt(ts, { hour: 'numeric', minute: '2-digit' });

/** "Mon, Oct 5 · 7:42 AM". */
export const formatWhen = (ts: number): string => `${formatDay(ts)} · ${formatClock(ts)}`;

/** "7:42 – 8:12 AM", or "11:50 AM – 12:20 PM" when the period changes. */
export function formatTimeSpan(start: number, end: number | null): string {
  const from = formatClock(start);
  if (end === null) return from;
  const to = formatClock(end);
  const period = (s: string) => s.slice(-2);
  return `${period(from) === period(to) ? from.slice(0, -3) : from} – ${to}`;
}

/** "24 min", "1 h 05 min", "<1 min". */
export function formatDuration(seconds: number): string {
  const min = Math.round(Math.max(0, seconds) / 60);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Spoken duration: "24 minutes", "1 hour 5 minutes". */
export function spokenDuration(seconds: number): string {
  const min = Math.round(Math.max(0, seconds) / 60);
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (h === 0) return part(m, 'minute');
  return m === 0 ? part(h, 'hour') : `${part(h, 'hour')} ${part(m, 'minute')}`;
}

/** "+167", "−44", "0". */
export const signedPoints = (n: number): string => formatPointsValue(n, true);

/** "Home → School", with "Start" / "End" for a missing label. */
export const routeLine = (d: Pick<LocalDrive, 'fromLabel' | 'toLabel'>): string =>
  `${d.fromLabel ?? 'Start'} → ${d.toLabel ?? 'End'}`;

/** The same route for a screen reader, which reads "→" as "right arrow". */
export const spokenRoute = (d: Pick<LocalDrive, 'fromLabel' | 'toLabel'>): string =>
  `${d.fromLabel ?? 'Start'} to ${d.toLabel ?? 'End'}`;

// ── Events ──────────────────────────────────────────────────────────────────────────────

export const EVENT_LABEL: Record<EventType, string> = {
  speeding: 'Speeding',
  hard_brake: 'Hard brake',
  hard_accel: 'Hard acceleration',
  hard_corner: 'Hard cornering',
  phone_pickup: 'Phone pickup',
  phone_handling: 'Phone handling',
  eyes_off: 'Eyes off road',
  drowsy: 'Drowsiness',
};

export const EVENT_ICON: Record<EventType, IconName> = {
  speeding: 'speedometer-outline',
  hard_brake: 'hand-left-outline',
  hard_accel: 'trending-up-outline',
  hard_corner: 'return-down-forward-outline',
  phone_pickup: 'phone-portrait-outline',
  phone_handling: 'phone-portrait-outline',
  eyes_off: 'eye-off-outline',
  drowsy: 'moon-outline',
};

/** Tier → design-system signal (minor yellow, moderate orange, severe red). */
export const TIER_SIGNAL: Record<Tier, Signal> = { minor: 'minor', moderate: 'moderate', severe: 'severe' };

export const TIER_WORD: Record<Tier, string> = { minor: 'Minor', moderate: 'Moderate', severe: 'Severe' };

/** Types with one tier only say their name; the rest add "minor" / "severe". */
const SINGLE_TIER: ReadonlySet<EventType> = new Set<EventType>(['phone_pickup', 'drowsy']);

/** "Hard brake · Severe", "Phone pickup". */
export function eventName(type: EventType, tier: Tier): string {
  return SINGLE_TIER.has(type) ? EVENT_LABEL[type] : `${EVENT_LABEL[type]} · ${TIER_WORD[tier]}`;
}

const TIER_RANK: Record<Tier, number> = { minor: 1, moderate: 2, severe: 3 };

/** The worse of two tiers (null = none). */
export function worseTier(a: Tier | null, b: Tier | null): Tier | null {
  if (a === null) return b;
  if (b === null) return a;
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

// ── History weeks ───────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Local midnight of the Monday on or before `ts`. */
export function weekStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** "This week", "Last week", "Sep 22 – 28", "Sep 29 – Oct 5". */
export function weekLabel(start: number, now: number): string {
  const current = weekStart(now);
  if (start === current) return 'This week';
  // Compare calendar weeks, not 7 × 24 h, so a DST change never mislabels one.
  const last = new Date(current);
  last.setDate(last.getDate() - 7);
  if (start === last.getTime()) return 'Last week';
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 6);
  const end = endDate.getTime();
  const sameMonth = new Date(start).getMonth() === endDate.getMonth();
  const from = fmt(start, { month: 'short', day: 'numeric' });
  const to = sameMonth ? fmt(end, { day: 'numeric' }) : fmt(end, { month: 'short', day: 'numeric' });
  return `${from} – ${to}`;
}

export interface WeekGroup {
  key: string;
  title: string;
  /** Net points over the week's scored drives. */
  points: number;
  miles: number;
  data: LocalDrive[];
}

/** Newest-first drives → newest-first weeks, each keeping the drives' order. */
export function groupByWeek(drives: readonly LocalDrive[], now: number): WeekGroup[] {
  const groups: WeekGroup[] = [];
  const byStart = new Map<number, WeekGroup>();
  for (const d of drives) {
    const start = weekStart(d.startedAt);
    let g = byStart.get(start);
    if (!g) {
      g = { key: `week-${new Date(start).toISOString().slice(0, 10)}`, title: weekLabel(start, now), points: 0, miles: 0, data: [] };
      byStart.set(start, g);
      groups.push(g);
    }
    g.data.push(d);
    g.miles += d.miles;
    // The same number each row shows: the stored net, else the server's.
    if (d.status === 'scored' || d.status === 'pending') g.points += d.pointsNet ?? d.result?.net ?? 0;
  }
  return groups;
}

export { DAY_MS };

/** A window start `days` back, rounded to the hour so a query key built from it stays put. */
export function sinceDays(now: number, days: number): number {
  const hour = 3_600_000;
  return Math.floor(now / hour) * hour - days * DAY_MS;
}
