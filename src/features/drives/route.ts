/**
 * Route geometry for the drive screens: decoding the (already privacy-trimmed) polyline, the cheap
 * SVG sketch used for history thumbnails and the share card, and the colouring of the summary map
 * (segments by the worst event in them, instant events as dots). Pure.
 */
import type { EventType, Tier } from '@scoring';

import { haversineMeters, type LatLng } from '@/lib/geo';
import { decodeRuns } from '@/lib/polyline';

import { worseTier } from './format';
import type { LocalDriveEvent } from './model';

/** A route as its visible runs: each is drawn on its own, never joined to the next. */
export type Runs = readonly (readonly LatLng[])[];

/**
 * The visible runs of a stored route (space-joined encoded polylines, `@/lib/polyline`). Each run
 * is one stretch between privacy cuts; a renderer must never draw from one run to the next. A
 * malformed route draws nothing.
 */
export function decodeRoute(polyline: string | null): LatLng[][] {
  if (!polyline) return [];
  try {
    return decodeRuns(polyline)
      .map((run) => run.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)))
      .filter((run) => run.length >= 2);
  } catch {
    return [];
  }
}

/** Every point of every run, for framing and bounds only — never for drawing. */
export const allPoints = (runs: Runs): LatLng[] => runs.flat();

/** Keeps at most `max` points, evenly spaced, always the first and last. */
export function thin(points: readonly LatLng[], max: number): LatLng[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/**
 * An SVG path that fits the route inside a `w` × `h` box (with `pad` on every side), keeping its
 * shape: longitude is scaled by cos(latitude) so a route doesn't stretch sideways. Every run is its
 * own `M…L…` subpath, so the pen lifts between runs and no line crosses a hidden gap. Null when
 * there is nothing to draw.
 */
export function sketchPath(runs: Runs, w: number, h: number, pad = 4, max = 120): string | null {
  const drawn = runs.filter((r) => r.length >= 2);
  const total = drawn.reduce((n, r) => n + r.length, 0);
  if (total < 2) return null;
  // Share the point budget across runs by size, at least the two ends each.
  const thinned = drawn.map((r) => thin(r, Math.max(2, Math.round((max * r.length) / total))));
  const all = thinned.flat();
  const k = Math.cos((all[0]!.lat * Math.PI) / 180);
  const xs = all.map((p) => p.lng * k);
  const ys = all.map((p) => -p.lat);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const span = Math.max(spanX, spanY);
  if (!(span > 0)) return null;
  const scale = Math.min((w - pad * 2) / (spanX || span), (h - pad * 2) / (spanY || span));
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;
  const parts: string[] = [];
  let i = 0;
  for (const run of thinned) {
    run.forEach((_, j) => {
      const x = offX + (xs[i]! - minX) * scale;
      const y = offY + (ys[i]! - minY) * scale;
      parts.push(`${j === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
      i += 1;
    });
  }
  return parts.join(' ');
}

// ── Summary map colouring ───────────────────────────────────────────────────────────────

/** Events that last along the road; the rest are instants drawn as dots. */
export const SEGMENT_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['speeding', 'phone_handling']);

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

/** The run and point index nearest `p` across every run (runs with under two points are skipped). */
function nearestIndex(runs: Runs, p: LatLng): { run: number; i: number } {
  let best = { run: 0, i: 0 };
  let bestD = Infinity;
  runs.forEach((points, run) => {
    if (points.length < 2) return;
    points.forEach((q, i) => {
      const d = haversineMeters(p, q);
      if (d < bestD) {
        bestD = d;
        best = { run, i };
      }
    });
  });
  return best;
}

const located = (e: LocalDriveEvent): LatLng | null =>
  e.lat === null || e.lng === null ? null : { lat: e.lat, lng: e.lng };

/** Disputes that were accepted no longer count anywhere, the map included. */
const counts = (e: LocalDriveEvent) => !e.removed && e.disputeStatus !== 'accepted';

/**
 * The route split into stretches of one colour: each lasting event (speeding, phone handling)
 * colours the visible run it happened on from where it began for about as far as its
 * duration covers, and an overlap takes the worse tier. A coloured stretch never leaves its run —
 * the output holds no segment from one visible run to the next.
 */
export function routeRuns(visible: Runs, events: readonly LocalDriveEvent[]): RouteRun[] {
  const drawn = visible.filter((r) => r.length >= 2);
  if (drawn.length === 0) return [];
  // One tier per segment (point i → i + 1) of each run.
  const segTier: (Tier | null)[][] = drawn.map((points) => points.slice(1).map(() => null));
  const cum: number[][] = drawn.map((points) => {
    const c: number[] = [0];
    for (let i = 1; i < points.length; i++) c.push(c[i - 1]! + haversineMeters(points[i - 1]!, points[i]!));
    return c;
  });

  for (const e of events) {
    const at = located(e);
    if (!SEGMENT_EVENTS.has(e.type) || at === null || !counts(e)) continue;
    const near = nearestIndex(drawn, at);
    const points = drawn[near.run]!;
    const tiers = segTier[near.run]!;
    const c = cum[near.run]!;
    const i0 = Math.min(near.i, points.length - 2);
    const length = Math.max(MIN_STRETCH_M, e.durationS * ASSUMED_MPS);
    for (let i = i0; i < tiers.length && (i === i0 || c[i + 1]! - c[i0]! <= length); i++) {
      tiers[i] = worseTier(tiers[i]!, e.tier);
    }
  }

  const runs: RouteRun[] = [];
  drawn.forEach((points, r) => {
    segTier[r]!.forEach((tier, i) => {
      const last = runs[runs.length - 1];
      // A stretch continues only within its own run (i > 0); each run starts a new one.
      if (i > 0 && last && last.tier === tier) last.points.push(points[i + 1]!);
      else runs.push({ tier, points: [points[i]!, points[i + 1]!] });
    });
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
