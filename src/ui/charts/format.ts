// The words the charts print and speak. Pure: no React, no theme.
//
// Band names and floors come from `@scoring` rather than being typed here, for the same reason the
// scoring explainer derives its caps from the engine: a tuning change has to move the chart with it.
import { band as bandOfScore, CONSTANTS } from '@scoring';
import type { ScoreBand } from '@scoring';

export { bandOfScore };

/** The four bands as the driver reads them (§9.6: labels, not grades). */
export const BAND_LABEL: Readonly<Record<ScoreBand, string>> = {
  excellent: 'Excellent',
  good: 'Good',
  getting_there: 'Getting there',
  needs_focus: 'Needs focus',
};

export function bandLabel(band: ScoreBand): string {
  return BAND_LABEL[band];
}

/** Band floors, highest first: the trend's shading and its tick marks are drawn from these. */
export const BAND_FLOORS: readonly { band: ScoreBand; floor: number }[] = [
  { band: 'excellent', floor: CONSTANTS.BAND_EXCELLENT },
  { band: 'good', floor: CONSTANTS.BAND_GOOD },
  { band: 'getting_there', floor: CONSTANTS.BAND_GETTING_THERE },
  { band: 'needs_focus', floor: 0 },
];

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A score is a whole number between 0 and 100 wherever it is printed. */
export function formatScore(score: number): string {
  return String(Math.round(clamp(score, 0, 100)));
}

/**
 * Points lost. Whole numbers print plain; anything else keeps one decimal, so a 0.4-point
 * deduction reads as 0.4 rather than vanishing into "0" beside a visible sliver of bar.
 */
export function formatPoints(points: number): string {
  if (!Number.isFinite(points)) return '—';
  const tenths = Math.round(points * 10) / 10;
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

export function describeScore(score: number, band: ScoreBand, provisional = false): string {
  return `Score ${formatScore(score)}, ${bandLabel(band)}${provisional ? ', provisional' : ''}`;
}

export type TrendPoint = {
  /** Short axis label, e.g. "Aug 4". */
  label: string;
  /** Null for a period with no score: the line breaks there and the table says so. */
  value: number | null;
  /** The row's name in the table and to a screen reader, when `label` is an abbreviation. */
  longLabel?: string;
};

export type TrendPeriod = { one: string; many: string };

export const WEEKS: TrendPeriod = { one: 'week', many: 'weeks' };

/** "Score trend, from 71 to 84 over 4 weeks". Periods without a score still count toward the span. */
export function describeTrend(points: readonly TrendPoint[], period: TrendPeriod = WEEKS): string {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) return 'Score trend, no scores yet';
  const n = points.length;
  const span = `${n} ${n === 1 ? period.one : period.many}`;
  const first = formatScore(values[0] ?? 0);
  const last = formatScore(values[values.length - 1] ?? 0);
  if (values.length === 1) {
    return n === 1 ? `Score trend, ${first}` : `Score trend, ${first} over ${span}`;
  }
  return `Score trend, from ${first} to ${last} over ${span}`;
}

export type CategoryBarRow = { label: string; value: number; cap: number };

/** "Points lost by category. Phone use 0 of 30 points, Speeding 12 of 25 points". */
export function describeBars(rows: readonly CategoryBarRow[]): string {
  if (rows.length === 0) return 'Points lost by category, none';
  const parts = rows.map(
    (r) => `${r.label} ${formatPoints(r.value)} of ${formatPoints(r.cap)} points`
  );
  return `Points lost by category. ${parts.join(', ')}`;
}
