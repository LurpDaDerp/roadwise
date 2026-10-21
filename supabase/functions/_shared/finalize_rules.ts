// The server-side rules around storing a drive that are not the scorer's: integrity (mock location
// or an implausible drive is stored unscored with a reason) and the server merge rule
// `drive_context` applies (its SQL holds the same numbers as literals). Pure, so every rule is a
// unit test.
import type { FinalizeTripPayloadV4 } from './payload.ts';
import { MERGE_GAP_S, MERGE_RADIUS_M } from './scoring/index';
import { decodeLine } from './speedLimits/geometry.ts';

/** Faster than this, sustained over a whole drive, is not a car on a road. */
export const MAX_AVG_MPH = 120;
/** A single fix faster than this is a GNSS fault or a fake. */
export const MAX_PEAK_MPH = 160;
/** Below this share of valid fixes the miles cannot be trusted (drives under a mile are excused). */
export const MIN_VALID_GNSS_PCT = 30;
/**
 * The server merge rule (`private.drive_context`, migration 0023): an upload that starts within
 * `gapS` of the user's latest kept drive's end, and within `radiusM` of where it ended, is joined
 * to it. The phone continues a drive by the same rule (scoring `MERGE_GAP_S`, `MERGE_RADIUS_M`);
 * the SQL literals are pinned by pgTAP (0023: 149 m and 300 s merge, 151 m and 301 s do not).
 */
export const SERVER_MERGE = { gapS: MERGE_GAP_S, radiusM: MERGE_RADIUS_M } as const;

/** The route may be up to this much longer than its drawn polyline (GPS noise, simplification)… */
export const POLYLINE_SLACK_FACTOR = 1.25;
/** …plus this many miles hidden by the 0.25 mi end trims and up to three 800 m privacy zones. */
export const POLYLINE_SLACK_MILES = 6;
const M_PER_MILE = 1609.344;

export type IntegrityReason = 'spoofed' | 'implausible';

/** A stored drive with one of these reasons is never a merge target. */
export const isRefusedReason = (reason: string | null | undefined): boolean => reason === 'spoofed' || reason === 'implausible';

/** The runs of an uploaded route: encoded polylines joined by single spaces (the device's `encodeRuns`). */
export const POLYLINE_RUN_SEPARATOR = ' ';

/**
 * The visible length of the uploaded route in miles: the sum of its runs, each decoded on its own
 * (a privacy zone mid-route splits the track into runs that are never joined). An empty or
 * undecodable run counts 0.
 */
export function polylineMiles(polyline: string): number {
  let m = 0;
  for (const run of polyline.split(POLYLINE_RUN_SEPARATOR)) {
    if (run === '') continue;
    let line: Float64Array;
    try {
      line = decodeLine(run);
    } catch {
      continue;
    }
    for (let i = 2; i < line.length; i += 2) {
      m += distanceM({ lat: line[i - 2], lng: line[i - 1] }, { lat: line[i], lng: line[i + 1] });
    }
  }
  return m / M_PER_MILE;
}

/** Miles far beyond what the route shows cannot be true: `miles > polyline × 1.25 + 6`. */
export const milesExceedRoute = (miles: number, polyline: string): boolean => miles > polylineMiles(polyline) * POLYLINE_SLACK_FACTOR + POLYLINE_SLACK_MILES;

/** Why a drive is stored unscored, or null when it may be scored. */
export function integrityReason(p: FinalizeTripPayloadV4): IntegrityReason | null {
  if (p.integrity.mockLocation) return 'spoofed';
  if (p.integrity.motionMismatch) return 'implausible';
  if (p.integrity.maxSpeedMph > MAX_PEAK_MPH) return 'implausible';
  const hours = p.durationS / 3600;
  if (hours > 0 && p.miles / hours > MAX_AVG_MPH) return 'implausible';
  if (p.miles >= 1 && p.integrity.validGnssPct < MIN_VALID_GNSS_PCT) return 'implausible';
  if (milesExceedRoute(p.miles, p.polyline)) return 'implausible';
  return null;
}

const R_M = 6_371_000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle metres between two points. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
