/**
 * Stat formatting shared by the Home stats card and All stats. Values and colours come from
 * `statsFrom` / `statColor` in @scoring; this only words and rounds them.
 */
import { statsFrom, type Stat, type StatId, type StatSums } from '@scoring';

import { distanceIn, per100In, per100Label, type Units } from '@/lib/units';
import type { StatHealth, TrendDirection } from '@/ui';

export const STAT_LABEL: Record<StatId, string> = {
  speeding: 'Speeding',
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

/** One-line explanations for All stats. */
export const STAT_HINT: Partial<Record<StatId, string>> = {
  speeding: 'Speeding incidents',
  harsh: 'Braking, acceleration and cornering',
  clean: 'Drives with zero events',
  handling: 'Time spent holding your phone',
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
      return per100Label(units);
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
 * The rate as shown, in the driver's units: "0.8" per 100 mi (or per 100 km), "92" %, "0.3" min
 * per hour, "312" mi (or km), "12.5" h, or "—".
 */
export function formatRate(stat: Stat, units: Units = 'mi'): { value: string; unit: string } {
  const unit = rateUnit(stat.unit, units);
  if (stat.value === null) return { value: '—', unit };
  switch (stat.unit) {
    case 'pct':
      return { value: String(Math.round(stat.value)), unit };
    case 'mi': {
      const v = distanceIn(stat.value, units);
      return { value: v >= 100 ? Math.round(v).toLocaleString('en-US') : oneDp(v), unit };
    }
    case 'per_100_mi':
      return { value: oneDp(per100In(stat.value, units)), unit };
    default:
      return { value: oneDp(stat.value), unit };
  }
}

/** The total as shown: "3" events, "12 of 15" clean drives, "4.5" min, "312" mi. */
export function formatTotal(stat: Stat, sums: StatSums, units: Units = 'mi'): { value: string; unit: string } {
  switch (stat.unit) {
    case 'per_100_mi':
      return { value: String(stat.total), unit: stat.total === 1 ? 'time' : 'times' };
    case 'pct':
      return { value: `${sums.cleanDrives} of ${sums.drives}`, unit: sums.drives === 1 ? 'drive' : 'drives' };
    case 'min_per_h':
      return { value: oneDp(stat.total), unit: 'min' };
    default:
      return formatRate(stat, units);
  }
}

/** Clean % is the one stat where higher is better. */
export const higherIsBetter = (id: StatId): boolean => id === 'clean';

/** Recent vs baseline, compared at the precision shown (1 dp), so "0.8 vs 0.8" is flat. */
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
 * Home's four: the last 7 days with an arrow against your own 30 days. With no drive in the last
 * 7 days, the 30-day values without arrows.
 */
export function homeStats(week: StatSums, month: StatSums, units: Units = 'mi'): { stats: HomeStat[]; window: '7d' | '30d' } {
  const useWeek = week.drives > 0;
  const shown = statsFrom(useWeek ? week : month).filter((s) => s.home);
  const base = statsFrom(month);
  const stats = shown.map((s) => {
    const { value, unit } = formatRate(s, units);
    const b = base.find((x) => x.id === s.id)?.value ?? null;
    return {
      id: s.id,
      label: STAT_LABEL[s.id],
      value,
      unit,
      health: s.color,
      trend: useWeek ? trendFor(s.value, b) : undefined,
      higherIsBetter: higherIsBetter(s.id),
    };
  });
  return { stats, window: useWeek ? '7d' : '30d' };
}

export type StatGroup = { title: string; ids: StatId[] };

/** All stats, in the spec table's order, in three groups. */
export const STAT_GROUPS: StatGroup[] = [
  { title: 'Headline', ids: ['speeding', 'pickups', 'harsh', 'clean'] },
  { title: 'In detail', ids: ['hard_brake', 'hard_accel', 'hard_corner', 'handling'] },
  { title: 'On the road', ids: ['miles', 'duration', 'night_miles'] },
];
