import { t } from '@/i18n';

import { metersToMiles } from './units';

/** Rendered in place of any value the app does not have; the string table is the only source. */
export const UNKNOWN = t('common.unknown');

export function formatSpeed(mph: number): string {
  return Number.isFinite(mph) ? String(Math.round(mph)) : UNKNOWN;
}

export function formatDistanceMi(meters: number): string {
  if (!Number.isFinite(meters)) return UNKNOWN;
  const mi = metersToMiles(meters);
  return t('format.distanceMi', { value: mi < 10 ? mi.toFixed(1) : Math.round(mi) });
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return UNKNOWN;
  const m = Math.round(seconds / 60);
  if (m < 60) return t('format.minutes', { m });
  const h = Math.floor(m / 60);
  return t('format.hoursMinutes', { h, m: String(m % 60).padStart(2, '0') });
}

export function formatPoints(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : UNKNOWN;
}
