/**
 * Row builders for the query-layer suites.
 *
 * Every fixture is pinned to UTC and to a Monday, so a week boundary, a local day and a rate per
 * 100 miles are all arithmetic a reader can do on paper: `MILE_M` metres is one mile, `HOUR_S`
 * seconds is one hour, and `T0` is noon on Monday 5 January 2026.
 */
import type { EventCategory } from '@scoring';

import type { EventRow, TripRow } from '@/data/db/types';

/** Monday 2026-01-05T12:00:00Z. */
export const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
export const DAY_MS = 86_400_000;
export const MILE_M = 1609.344;
export const HOUR_S = 3600;

const NO_DEDUCTIONS: Record<EventCategory, number> = {
  phone: 0,
  speeding: 0,
  braking: 0,
  accel: 0,
  cornering: 0,
  focus: 0,
};

export function deductions(over: Partial<Record<EventCategory, number>> = {}) {
  return { ...NO_DEDUCTIONS, ...over };
}

const BASE: TripRow = {
  client_trip_id: 'trip-1',
  started_at: T0,
  ended_at: T0 + 30 * 60_000,
  tz: 'UTC',
  distance_m: 10 * MILE_M,
  duration_s: 1800,
  role: 'driver',
  role_confidence: 0.95,
  role_source: 'auto',
  mode: null,
  camera_session: 0,
  score: 90,
  scoring_version: '1',
  category_deductions_json: JSON.stringify(NO_DEDUCTIONS),
  exposure: 1,
  data_quality: 'A',
  conditions_json: JSON.stringify({ night: false, precipitation: false, hadSevereEvent: false }),
  limit_coverage_pct: 80,
  start_label: 'Near Home',
  end_label: 'Near Lincoln HS',
  start_geohash5: null,
  end_geohash5: null,
  polyline: null,
  status: 'provisional',
  sync_state: 'queued',
  checkpoint_ts: null,
  incomplete: 0,
  server_id: null,
  sync_error: null,
  deleted_at: null,
  created_at: T0,
  updated_at: T0,
};

/** A scored trip row; `over` replaces any column. */
export function tripRow(over: Partial<TripRow> = {}): TripRow {
  const row = { ...BASE, ...over };
  // Keep the end consistent with the duration unless the caller pinned one explicitly.
  if (over.ended_at === undefined && (over.started_at !== undefined || over.duration_s !== undefined)) {
    row.ended_at = row.started_at + row.duration_s * 1000;
  }
  return row;
}

const EVENT_BASE: EventRow = {
  id: 'event-1',
  client_trip_id: 'trip-1',
  category: 'speeding',
  started_at: T0 + 60_000,
  duration_s: 38,
  lat: 45.5,
  lng: -122.6,
  measured_json: JSON.stringify({ speedMps: 21, limitMps: 15.6, overMps: 5.4 }),
  severity: '3.5',
  confidence: 0.9,
  context_json: JSON.stringify({ night: false, precipitation: false }),
  deduction: 6,
  alert_shown: 1,
  corrected: 0,
  status: 'scored',
  source: 'gnss',
  dispute_json: null,
};

export function eventRow(over: Partial<EventRow> = {}): EventRow {
  return { ...EVENT_BASE, ...over };
}
