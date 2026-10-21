// Driving stats and their colours (the Home stats table).
import { roundTo } from './num';

/** Raw sums over a window (one user's trips), as stored on the device or returned by the server. */
export interface StatSums {
  miles: number;
  durationS: number;
  nightMiles: number;
  drives: number;
  cleanDrives: number;
  speeding: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
}

export type StatId =
  | 'speeding'
  | 'harsh'
  | 'clean'
  | 'hard_brake'
  | 'hard_accel'
  | 'hard_corner'
  | 'miles'
  | 'duration'
  | 'night_miles';

export type StatUnit = 'per_100_mi' | 'pct' | 'mi' | 'h';
export type StatColor = 'green' | 'yellow' | 'red';

export interface Stat {
  id: StatId;
  /** The rate (2 dp) in `unit`; null when there is nothing to divide by. */
  value: number | null;
  /** The underlying total: a count, clean drives, miles or hours. */
  total: number;
  unit: StatUnit;
  color: StatColor | null;
  /** One of the 4 headline stats on Home. */
  home: boolean;
}

/**
 * Colour bands from the spec. Lower is better unless `higherIsBetter`: green at or below `green`,
 * red strictly above `red`, yellow between. Clean %: green at or above 80, red strictly below 50.
 */
export const STAT_THRESHOLDS: Partial<Record<StatId, { green: number; red: number; higherIsBetter?: true }>> = {
  speeding: { green: 1, red: 4 },
  harsh: { green: 4, red: 12 },
  clean: { green: 80, red: 50, higherIsBetter: true },
  hard_brake: { green: 2, red: 6 },
  hard_accel: { green: 2, red: 6 },
  hard_corner: { green: 2, red: 6 },
};

export function statColor(id: StatId, value: number | null): StatColor | null {
  const t = STAT_THRESHOLDS[id];
  if (!t || value === null || !Number.isFinite(value)) return null;
  if (t.higherIsBetter) return value >= t.green ? 'green' : value < t.red ? 'red' : 'yellow';
  return value <= t.green ? 'green' : value > t.red ? 'red' : 'yellow';
}

/** Home's four headline stats: speeding, harsh events, clean drives and distance. */
const HOME: ReadonlySet<StatId> = new Set<StatId>(['speeding', 'harsh', 'clean', 'miles']);

/** Every stat, in the spec table's order; `home` marks Home's four. */
export function statsFrom(s: StatSums): Stat[] {
  const per100 = (n: number) => (s.miles > 0 ? roundTo((n * 100) / s.miles, 2) : null);
  const hours = roundTo(s.durationS / 3600, 2);
  const harsh = s.hardBrake + s.hardAccel + s.hardCorner;

  const rows: [StatId, number | null, number, StatUnit][] = [
    ['speeding', per100(s.speeding), s.speeding, 'per_100_mi'],
    ['harsh', per100(harsh), harsh, 'per_100_mi'],
    ['clean', s.drives > 0 ? roundTo((s.cleanDrives * 100) / s.drives, 2) : null, s.cleanDrives, 'pct'],
    ['hard_brake', per100(s.hardBrake), s.hardBrake, 'per_100_mi'],
    ['hard_accel', per100(s.hardAccel), s.hardAccel, 'per_100_mi'],
    ['hard_corner', per100(s.hardCorner), s.hardCorner, 'per_100_mi'],
    ['miles', roundTo(s.miles, 2), roundTo(s.miles, 2), 'mi'],
    ['duration', hours, hours, 'h'],
    ['night_miles', roundTo(s.nightMiles, 2), roundTo(s.nightMiles, 2), 'mi'],
  ];
  return rows.map(([id, value, total, unit]) => ({ id, value, total, unit, color: statColor(id, value), home: HOME.has(id) }));
}
