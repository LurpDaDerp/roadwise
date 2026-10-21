/**
 * Number formatting for the Analytics cards: every value comes back as a short number plus a
 * unit, so the number sits in the display face and the unit beside it in small print. Pure.
 */
import { distanceIn, distanceWord, type Units } from '@/lib/units';

/** A number for the display face, its printed unit and the words a screen reader says. */
export interface Metric {
  value: string;
  unit: string;
  spoken: string;
}

const DASH = '—';

/** "12.4 mi" under 100, "1,204 km" from 100 up; a dash with no drives. */
export function distanceMetric(miles: number | null, units: Units): Metric {
  if (miles === null || !Number.isFinite(miles)) return { value: DASH, unit: units, spoken: 'no data' };
  const v = distanceIn(Math.max(0, miles), units);
  const value = v >= 100 ? Math.round(v).toLocaleString('en-US') : (Math.round(v * 10) / 10).toFixed(1);
  return { value, unit: units, spoken: `${value} ${distanceWord(units)}` };
}

/** "42 min" under an hour, "1.5 h" under ten hours, "152 h" from there; "<1 min" for a few seconds. */
export function timeMetric(seconds: number): Metric {
  const s = Math.max(0, seconds);
  if (s === 0) return { value: '0', unit: 'min', spoken: '0 minutes' };
  const min = Math.round(s / 60);
  if (min < 1) return { value: '<1', unit: 'min', spoken: 'under a minute' };
  if (min < 60) return { value: String(min), unit: 'min', spoken: `${min} minute${min === 1 ? '' : 's'}` };
  const h = s / 3600;
  const value = h < 10 ? (Math.round(h * 10) / 10).toFixed(1) : Math.round(h).toLocaleString('en-US');
  return { value, unit: 'h', spoken: `${value} hours` };
}

/** Average speed in the driver's units ("32 mph" / "51 km/h"); a dash with no drive time. */
export function speedMetric(mph: number | null, units: Units): Metric {
  const unit = units === 'km' ? 'km/h' : 'mph';
  if (mph === null || !Number.isFinite(mph)) return { value: DASH, unit, spoken: 'no data' };
  const value = String(Math.round(distanceIn(mph, units)));
  return { value, unit, spoken: `${value} ${units === 'km' ? 'kilometers per hour' : 'miles per hour'}` };
}

/** A plain count. */
export const countMetric = (n: number): Metric => {
  const value = Math.round(n).toLocaleString('en-US');
  return { value, unit: '', spoken: value };
};

/** "75 %", or a dash with no drives. */
export function percentMetric(pct: number | null): Metric {
  if (pct === null) return { value: DASH, unit: '%', spoken: 'no data' };
  return { value: String(pct), unit: '%', spoken: `${pct} percent` };
}
