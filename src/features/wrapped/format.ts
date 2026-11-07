/**
 * The Wrapped story's numbers in words (pure), and which slides a story has.
 */
import type { CategoryId, PercentileKey } from '@/data/server/wrapped';
import { formatRating } from '@/lib/rating';
import { distanceUnit, KM_PER_MILE, type Units } from '@/lib/units';

import { wrappedCopy as copy } from './copy';
import type { WrappedPlaces } from './places';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = {
  speed: 'Speed',
  braking: 'Braking',
  acceleration: 'Acceleration',
  turning: 'Turning',
  phone: 'Phone use',
  attention: 'Attention',
};

/** "Monday" for ISO weekday 1; "" for anything else. */
export function weekdayName(iso: number): string {
  return Number.isInteger(iso) && iso >= 1 && iso <= 7 ? WEEKDAYS[iso - 1]! : '';
}

const hourWord = (h: number): string => (h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : String(h % 12));
const half = (h: number): 'AM' | 'PM' | null => (h === 0 || h === 12 || h === 24 ? null : h < 12 ? 'AM' : 'PM');

/** A 3-hour band in words: "6–9 AM", "9 AM–noon", "noon–3 PM", "9 PM–midnight", "midnight–3 AM". */
export function bandLabel(startHour: number): string {
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 21 || startHour % 3 !== 0) return '';
  const a = startHour;
  const b = startHour + 3;
  const ha = half(a);
  const hb = half(b);
  // One AM/PM mark when both ends share it ("6–9 AM"); each its own otherwise ("9 AM–noon").
  if (ha !== null && ha === hb) return `${hourWord(a)}–${hourWord(b)} ${hb}`;
  return `${hourWord(a)}${ha ? ` ${ha}` : ''}–${hourWord(b)}${hb ? ` ${hb}` : ''}`;
}

/** A share as a whole percentage: 0.643 → "64%". */
export function percent(share: number): string {
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;
}

/** A per-100-mile rate in the driver's units, one decimal: `{ value: '2.4', per: 'per 100 mi' }` (per 100 km in km). */
export function rateParts(per100mi: number, units: Units): { value: string; per: string } {
  const v = units === 'km' ? per100mi / KM_PER_MILE : per100mi;
  return { value: (Math.round(Math.max(0, v) * 10) / 10).toFixed(1), per: copy.per100(distanceUnit(units)) };
}

/** "2.4 per 100 mi". */
export function rateText(per100mi: number, units: Units): string {
  const r = rateParts(per100mi, units);
  return `${r.value} ${r.per}`;
}

/** The lowest "Better than" the story shows: anything under it is never said (no shaming). */
export const PERCENTILE_MIN = 10;

/** "Better than 72% of drivers" ("More miles than 72% of drivers"); null when hidden. */
export function percentileText(key: PercentileKey, x: number | null | undefined): string | null {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < PERCENTILE_MIN) return null;
  const n = Math.min(100, Math.round(x));
  return key === 'miles' ? copy.moreMiles(n) : copy.better(n);
}

/** The Safety Rating at month end, as every screen shows it: a whole number, or "No rating yet". */
export function ratingText(end: number | null): string {
  return end === null ? copy.safety.noRating : formatRating(end, true);
}

/**
 * The month's change in the rating, between the whole numbers shown: "Up 5 since October 1",
 * "Down 2 since …", "Same as on October 1"; null without both ends.
 */
export function ratingChangeText(start: number | null, end: number | null, month: string): string | null {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const d = Math.round(end) - Math.round(start);
  if (d > 0) return copy.safety.up(d, month);
  if (d < 0) return copy.safety.down(-d, month);
  return copy.safety.same(month);
}

export type SlideId = 'intro' | 'totals' | 'safety' | 'smoothness' | 'phoneSpeed' | 'habits' | 'places' | 'progress' | 'archetype' | 'summary';

/**
 * The story's slides, in order. The own story: every slide, Places only with a most-driven trip,
 * Progress only with a badge or a goal done. A shared one: never Places, Progress only with a badge.
 */
export function storySlides(
  kind: 'own' | 'shared',
  p: { badges: number; goals: number; places: WrappedPlaces | null }
): SlideId[] {
  const out: SlideId[] = ['intro', 'totals', 'safety', 'smoothness', 'phoneSpeed', 'habits'];
  if (kind === 'own' && p.places?.pair) out.push('places');
  if (p.badges > 0 || (kind === 'own' && p.goals > 0)) out.push('progress');
  out.push('archetype', 'summary');
  return out;
}
