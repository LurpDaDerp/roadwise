/**
 * Stat formatting for the Home stats card and a friend's 30-day stats. Values and colours come
 * from `statsFrom` / `statColor` in @scoring; this only words and rounds them.
 */
import { statsFrom, type Stat, type StatId, type StatSums } from '@scoring';

import { distanceIn, type Units } from '@/lib/units';
import type { StatHealth, TrendDirection } from '@/ui';

export const STAT_LABEL: Record<StatId, string> = {
  speeding: 'Speeding events',
  pickups: 'Phone pickups',
  harsh: 'Harsh driving',
  clean: 'Clean drives',
  hard_brake: 'Hard braking',
  hard_accel: 'Hard acceleration',
  hard_corner: 'Hard cornering',
  handling: 'Phone handling',
  miles: 'Miles',
  duration: 'Time on the road',
  night_miles: 'Night miles',
};

export const EMPTY_SUMS: StatSums = {
  miles: 0,
  durationS: 0,
  nightMiles: 0,
  drives: 0,
  cleanDrives: 0,
  speeding: 0,
  pickups: 0,
  handlingS: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
};

const rateUnit = (unit: Stat['unit'], units: Units): string => {
  switch (unit) {
    case 'per_100_mi':
      return '';
    case 'pct':
      return '%';
    case 'min_per_h':
      return 'min per hour';
    case 'mi':
      return units;
    case 'h':
      return 'h';
  }
};

const oneDp = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * A stat as shown, in the driver's units: an event stat's total over the window ("3", never a rate
 * per distance), "92" %, "0.3" min per hour, "312" mi (or km), "12.5" h, or "—".
 */
export function formatStat(stat: Stat, units: Units = 'mi'): { value: string; unit: string } {
  const unit = rateUnit(stat.unit, units);
  if (stat.unit === 'per_100_mi') return { value: Math.round(stat.total).toLocaleString('en-US'), unit };
  if (stat.value === null) return { value: '—', unit };
  switch (stat.unit) {
    case 'pct':
      return { value: String(Math.round(stat.value)), unit };
    case 'mi': {
      const v = distanceIn(stat.value, units);
      return { value: v >= 100 ? Math.round(v).toLocaleString('en-US') : oneDp(v), unit };
    }
    default:
      return { value: oneDp(stat.value), unit };
  }
}

/** Clean % is the one stat where higher is better. */
export const higherIsBetter = (id: StatId): boolean => id === 'clean';

/** Recent vs baseline, compared at 1 dp, so "0.8 vs 0.8" is flat. */
export function trendFor(recent: number | null, base: number | null): TrendDirection | undefined {
  if (recent === null || base === null) return undefined;
  const a = Math.round(recent * 10);
  const b = Math.round(base * 10);
  return a === b ? 'flat' : a > b ? 'up' : 'down';
}

export interface HomeStat {
  id: StatId;
  label: string;
  value: string;
  unit: string;
  health: StatHealth | null;
  trend?: TrendDirection;
  higherIsBetter: boolean;
}

/**
 * Home's four: the last 7 days with an arrow against your own 30 days (an event count against your
 * average week in them, the 30-day total × 7/30; clean % against the 30-day share). With no drive
 * in the last 7 days, the 30-day values without arrows.
 */
export function homeStats(week: StatSums, month: StatSums, units: Units = 'mi'): { stats: HomeStat[]; window: '7d' | '30d' } {
  const useWeek = week.drives > 0;
  const shown = statsFrom(useWeek ? week : month).filter((s) => s.home);
  const base = statsFrom(month);
  const stats = shown.map((s) => {
    const { value, unit } = formatStat(s, units);
    const b = base.find((x) => x.id === s.id);
    const trend = s.unit === 'per_100_mi' ? trendFor(s.total, b ? (b.total * 7) / 30 : null) : trendFor(s.value, b?.value ?? null);
    return {
      id: s.id,
      label: STAT_LABEL[s.id],
      value,
      unit,
      health: s.color,
      trend: useWeek ? trend : undefined,
      higherIsBetter: higherIsBetter(s.id),
    };
  });
  return { stats, window: useWeek ? '7d' : '30d' };
}
