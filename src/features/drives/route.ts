/**
 * Route geometry for the drive screens: decoding the (already privacy-trimmed) polyline, the cheap
 * SVG sketch used for history thumbnails and the share card, and the colouring of the summary map
 * (segments by the worst event in them, instant events as dots). Pure.
 */
import type { EventType, Tier } from '@scoring';

import { haversineMeters, type LatLng } from '@/lib/geo';
import { decodePolyline } from '@/lib/polyline';

import { worseTier } from './format';
import type { LocalDriveEvent } from './model';

export function decodeRoute(polyline: string | null): LatLng[] {
  if (!polyline) return [];
  try {
    return decodePolyline(polyline).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  } catch {
    return [];
  }
}

/** Keeps at most `max` points, evenly spaced, always the first and last. */
export function thin(points: readonly LatLng[], max: number): LatLng[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/**
 * An SVG path that fits the route inside a `w` × `h` box (with `pad` on every side), keeping its
 * shape: longitude is scaled by cos(latitude) so a route doesn't stretch sideways. Null when there
 * is nothing to draw.
 */
export function sketchPath(points: readonly LatLng[], w: number, h: number, pad = 4, max = 120): string | null {
  const pts = thin(points, max);
  if (pts.length < 2) return null;
  const k = Math.cos((pts[0]!.lat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * k);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const span = Math.max(spanX, spanY);
  if (!(span > 0)) return null;
  const scale = Math.min((w - pad * 2) / (spanX || span), (h - pad * 2) / (spanY || span));
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;
  return pts
    .map((_, i) => {
      const x = offX + (xs[i]! - minX) * scale;
      const y = offY + (ys[i]! - minY) * scale;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

// ── Summary map colouring ───────────────────────────────────────────────────────────────

/** Events that last along the road; the rest are instants drawn as dots. */
export const SEGMENT_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['speeding', 'phone_handling', 'drowsy']);

/** Rough road speed used to turn a duration into a stretch of route (≈ 30 mph). */
const ASSUMED_MPS = 13.4;
const MIN_STRETCH_M = 150;

export interface RouteRun {
  /** null = clean (green). */
  tier: Tier | null;
  points: LatLng[];
}

export interface RouteDot {
  id: string;
  tier: Tier;
  type: EventType;
  at: LatLng;
}

function nearestIndex(points: readonly LatLng[], p: LatLng): number {
  let best = 0;
  let bestD = Infinity;
  points.forEach((q, i) => {
    const d = haversineMeters(p, q);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

const located = (e: LocalDriveEvent): LatLng | null =>
  e.lat === null || e.lng === null ? null : { lat: e.lat, lng: e.lng };

/** Disputes that were accepted no longer count anywhere, the map included. */
const counts = (e: LocalDriveEvent) => !e.removed && e.disputeStatus !== 'accepted';

/**
 * The route split into runs of one colour: each lasting event (speeding, phone handling,
 * drowsiness) colours the stretch from where it began for about as far as its duration covers,
 * and an overlap takes the worse tier.
 */
export function routeRuns(points: readonly LatLng[], events: readonly LocalDriveEvent[]): RouteRun[] {
  if (points.length < 2) return [];
  // One tier per segment (point i → i + 1).
  const segTier: (Tier | null)[] = points.slice(1).map(() => null);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + haversineMeters(points[i - 1]!, points[i]!));

  for (const e of events) {
    const at = located(e);
    if (!SEGMENT_EVENTS.has(e.type) || at === null || !counts(e)) continue;
    const i0 = Math.min(nearestIndex(points, at), points.length - 2);
    const length = Math.max(MIN_STRETCH_M, e.durationS * ASSUMED_MPS);
    for (let i = i0; i < segTier.length && (i === i0 || cum[i + 1]! - cum[i0]! <= length); i++) {
      segTier[i] = worseTier(segTier[i]!, e.tier);
    }
  }

  const runs: RouteRun[] = [];
  segTier.forEach((tier, i) => {
    const last = runs[runs.length - 1];
    if (last && last.tier === tier) last.points.push(points[i + 1]!);
    else runs.push({ tier, points: [points[i]!, points[i + 1]!] });
  });
  return runs;
}

/** Instant events with a location (not inside a privacy zone or the trimmed ends). */
export function routeDots(events: readonly LocalDriveEvent[]): RouteDot[] {
  const dots: RouteDot[] = [];
  for (const e of events) {
    const at = located(e);
    if (SEGMENT_EVENTS.has(e.type) || at === null || !counts(e)) continue;
    dots.push({ id: e.id, tier: e.tier, type: e.type, at });
  }
  return dots;
}

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** A region that frames every point with a margin; null with nothing to frame. */
export function regionFor(points: readonly LatLng[]): Region | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.005, (maxLat - minLat) * 1.4),
    longitudeDelta: Math.max(0.005, (maxLng - minLng) * 1.4),
  };
}
