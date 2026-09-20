import { metersToMiles } from './units';

export const UNKNOWN = '—';

export function formatSpeed(mph: number): string {
  return Number.isFinite(mph) ? String(Math.round(mph)) : UNKNOWN;
}

export function formatDistanceMi(meters: number): string {
  const mi = metersToMiles(meters);
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

export function formatPoints(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}
