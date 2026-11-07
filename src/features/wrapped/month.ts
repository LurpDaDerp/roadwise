/**
 * Wrapped months (pure): a month is `YYYY-MM`, a calendar month of local days. Home's card shows
 * last month's Wrapped from the 1st through the 7th of the month (local), once the driver has one.
 */
import type { WrappedArchiveEntry } from '@/data/server/wrapped';
import { MONTH_RE } from '@/data/server/wrappedIds';
import { dayKey } from '@/lib/time';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** Home's card shows on these first days of the month. */
export const CARD_LAST_DAY = 7;

/** Settings key: the month whose Home card was closed (`'YYYY-MM'`); wiped at sign-out (`SIGN_OUT_SETTINGS`). */
export const WRAPPED_CARD_DISMISSED_KEY = 'home.wrappedCardDismissed';

export const isMonth = (m: unknown): m is string => typeof m === 'string' && MONTH_RE.test(m);

/** "October" for `2026-10`; "" for a malformed month. */
export function monthName(month: string): string {
  return isMonth(month) ? MONTH_NAMES[Number(month.slice(5, 7)) - 1]! : '';
}

/** "October 2026". */
export function monthYear(month: string): string {
  return isMonth(month) ? `${monthName(month)} ${month.slice(0, 4)}` : '';
}

/** The month of a moment, in `tz` (the phone's zone when absent). */
export function monthOf(ts: number, tz?: string): string {
  return dayKey(new Date(ts), tz).slice(0, 7);
}

/** The month before. */
export function previousMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Today is one of the card's days (the 1st through the 7th, in `tz`). */
export function inCardWindow(now: number, tz?: string): boolean {
  return Number(dayKey(new Date(now), tz).slice(8, 10)) <= CARD_LAST_DAY;
}

/**
 * The archive line Home's card shows, or null: on the card's days, last month's line when the
 * driver has one (3 or more scored drives) and hasn't closed this month's card.
 */
export function homeCardEntry(now: number, tz: string | undefined, archive: readonly WrappedArchiveEntry[] | undefined, dismissed: string | null): WrappedArchiveEntry | null {
  if (!archive || !inCardWindow(now, tz)) return null;
  const last = previousMonth(monthOf(now, tz));
  if (dismissed === last) return null;
  return archive.find((e) => e.month === last) ?? null;
}
