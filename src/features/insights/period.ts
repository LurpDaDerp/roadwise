/**
 * The period selector's vocabulary (§7.E E1: 4 wk / 3 mo / 12 mo / all), as it travels in the
 * route's `period` query param and as it is printed and spoken.
 */
import { INSIGHTS_PERIODS, type InsightsPeriod } from '@/data/queries';

import { insightsCopy as copy } from './copy';

export type { InsightsPeriod };

export const DEFAULT_PERIOD: InsightsPeriod = '4w';

/**
 * A query param is untyped — a string, a repeated string, or missing — and a stale or hand-typed
 * link must not take the screen down. Anything that is not one of the four periods is the default.
 */
export function parsePeriod(
  raw: string | readonly string[] | undefined,
  fallback: InsightsPeriod = DEFAULT_PERIOD
): InsightsPeriod {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (INSIGHTS_PERIODS as readonly string[]).includes(value as string)
    ? (value as InsightsPeriod)
    : fallback;
}

export interface PeriodOption {
  value: InsightsPeriod;
  /** What the segment prints. */
  short: string;
  /** What the segment is called to a screen reader. */
  spoken: string;
}

export const PERIOD_OPTIONS: readonly PeriodOption[] = INSIGHTS_PERIODS.map((value) => ({
  value,
  short: copy.period.options[value].short,
  spoken: copy.period.options[value].spoken,
}));

/** "over 4 weeks" / "since your first drive" — the tail of every summary sentence. */
export function periodPhrase(period: InsightsPeriod): string {
  return copy.period.options[period].over;
}
