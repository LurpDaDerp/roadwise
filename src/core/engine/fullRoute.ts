// The drive's whole route for the driver's own views (`trips.route_full`): every valid fix as this
// phone recorded it, the ends and the privacy zones included. It never leaves the phone: the upload
// and everything friends see carry the trimmed route (`trimRoute`, `privacy.ts`).
//
// The same format as the trimmed polyline (encoded runs, space-joined, `@/lib/polyline`), so every
// reader decodes both alike. The track is one run: the trimmed route splits only at its hidden
// gaps, never at a GNSS jump, and so does this one.
import type { LatLng } from '@/lib/geo';

import type { TrackPoint } from './engine.types';
import { fitRuns, POLYLINE_EPSILON_M, roundCoord5, trackIndexAt } from './privacy';

/** The local cap on a drive's whole route, in bytes; the tolerance doubles until it fits. */
export const MAX_ROUTE_FULL_BYTES = 256 * 1024;

/**
 * The whole track, simplified at `POLYLINE_EPSILON_M` and doubling until the encoding fits in
 * `maxBytes`; '' when there are fewer than two fixes.
 */
export function fullRoute(track: readonly TrackPoint[], maxBytes: number = MAX_ROUTE_FULL_BYTES): string {
  if (track.length < 2) return '';
  const points = track.map((p) => ({ lat: p.lat, lng: p.lng }));
  return fitRuns([points], POLYLINE_EPSILON_M, maxBytes)[0] ?? '';
}

/**
 * Where an event at `ts` happened on the whole track (5 dp): the last fix at or before it, else
 * the first, as `trimRoute`'s `locate` reads it, but never hidden. Null on an empty track.
 */
export function placeOnTrack(track: readonly TrackPoint[], ts: number): LatLng | null {
  const i = trackIndexAt(track, ts);
  if (i < 0) return null;
  const p = track[i] as TrackPoint;
  return { lat: roundCoord5(p.lat), lng: roundCoord5(p.lng) };
}
