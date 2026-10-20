/**
 * Route geometry for the drive screens: decoding the (already privacy-trimmed) polyline, the cheap
 * SVG sketch used for history thumbnails and the share card, and the marks on the summary map
 * (a pin per event and the stretch of route it covered, a dot when too short to see). Pure.
 */
import type { EventType, Tier } from '@scoring';

import { haversineMeters, type LatLng } from '@/lib/geo';
import { decodeRuns } from '@/lib/polyline';

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

// ── Summary map marks ───────────────────────────────────────────────────────────────────

/** Rough road speed used to turn a duration into a stretch of route (≈ 30 mph). */
const ASSUMED_MPS = 13.4;
const MPH_TO_MPS = 0.44704;
/** Metres per degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_320;

/** One event on the summary map: a pin where it happened and the stretch of route it covered. */
export interface EventMark {
  id: string;
  type: EventType;
  tier: Tier;
  /** Where it happened: the pin's tip. */
  at: LatLng;
  /** The route from where it began for as far as its duration covers, inside one visible run. */
  stretch: LatLng[];
  /** The stretch's length along the road, in metres (0 for an instant at the end of a run). */
  lengthM: number;
}

const located = (e: LocalDriveEvent): LatLng | null =>
  e.lat === null || e.lng === null ? null : { lat: e.lat, lng: e.lng };

/** Disputes that were accepted no longer count anywhere, the map included. */
const counts = (e: LocalDriveEvent) => !e.removed && e.disputeStatus !== 'accepted';

/** Cumulative distance along a run, metres, one entry per point. */
function cumulative(points: readonly LatLng[]): number[] {
  const c: number[] = [0];
  for (let i = 1; i < points.length; i++) c.push(c[i - 1]! + haversineMeters(points[i - 1]!, points[i]!));
  return c;
}

/** The point `d` metres along a run. */
function pointAt(points: readonly LatLng[], cum: readonly number[], d: number): LatLng {
  let i = 1;
  while (i < points.length - 1 && cum[i]! < d) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const seg = cum[i]! - cum[i - 1]!;
  const t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[i - 1]!) / seg)) : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** The part of a run from `d0` to `d1` metres along it: the two cut points and every point between. */
function slice(points: readonly LatLng[], cum: readonly number[], d0: number, d1: number): LatLng[] {
  const out = [pointAt(points, cum, d0)];
  points.forEach((p, i) => {
    if (cum[i]! > d0 && cum[i]! < d1) out.push(p);
  });
  out.push(pointAt(points, cum, d1));
  return out;
}

/** Where `p` falls on the route: the run and how far along it, from the nearest point on any segment. */
function project(runs: readonly (readonly LatLng[])[], cums: readonly number[][], p: LatLng): { run: number; d: number } {
  const k = Math.cos((p.lat * Math.PI) / 180);
  let best = { run: 0, d: 0 };
  let bestD = Infinity;
  runs.forEach((points, r) => {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      // A flat local frame is plenty at road scale.
      const bx = (b.lng - a.lng) * k;
      const by = b.lat - a.lat;
      const px = (p.lng - a.lng) * k;
      const py = p.lat - a.lat;
      const len2 = bx * bx + by * by;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / len2)) : 0;
      const dist = (px - t * bx) ** 2 + (py - t * by) ** 2;
      if (dist < bestD) {
        bestD = dist;
        best = { run: r, d: cums[r]![i - 1]! + t * (cums[r]![i]! - cums[r]![i - 1]!) };
      }
    }
  });
  return best;
}

const TIER_ORDER: Record<Tier, number> = { minor: 1, moderate: 2, severe: 3 };

/**
 * Every counted event with a location, as a pin and the stretch of route it covered: from the
 * point on the route nearest where it began, along the road for its duration at its measured
 * speed (else ≈ 30 mph). A stretch never leaves its visible run; one that would run past the end
 * of its run ends there and starts earlier instead. Events inside a privacy zone have no location
 * and stay off the map, as do removed ones. Ordered minor → severe, the order they are drawn in,
 * so the worst sits on top.
 */
export function eventMarks(visible: Runs, events: readonly LocalDriveEvent[]): EventMark[] {
  const drawn = visible.filter((r) => r.length >= 2);
  const cums = drawn.map(cumulative);
  const marks: EventMark[] = [];
  for (const e of events) {
    const at = located(e);
    if (at === null || !counts(e)) continue;
    let stretch: LatLng[] = [];
    let lengthM = 0;
    if (drawn.length > 0) {
      const near = project(drawn, cums, at);
      const points = drawn[near.run]!;
      const cum = cums[near.run]!;
      const total = cum[cum.length - 1]!;
      const mps = e.measured.speedMph ? e.measured.speedMph * MPH_TO_MPS : ASSUMED_MPS;
      const want = Math.min(total, Math.max(0, e.durationS) * mps);
      const d1 = Math.min(total, near.d + want);
      const d0 = Math.max(0, d1 - want);
      stretch = slice(points, cum, d0, d1);
      lengthM = d1 - d0;
    }
    marks.push({ id: e.id, type: e.type, tier: e.tier, at, stretch, lengthM });
  }
  return marks.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

/** On-screen size, in points, below which a stretch is drawn as a dot of this diameter instead. */
export const MIN_MARK_PX = 12;

/**
 * How a stretch shows on a map at `metersPerPx`: a line when it is at least `MIN_MARK_PX` long on
 * screen, else a dot, so a one-second brake on a long drive still shows.
 */
export const markShape = (lengthM: number, metersPerPx: number): 'line' | 'dot' =>
  metersPerPx > 0 && lengthM / metersPerPx >= MIN_MARK_PX ? 'line' : 'dot';

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

/**
 * Roughly how many metres one on-screen point spans on a square map `side` points wide showing
 * `region`: the map fits the region's longer side, so that side sets the scale.
 */
export function metersPerPixel(region: Region, side: number): number {
  if (!(side > 0)) return 0;
  const k = Math.cos((region.latitude * Math.PI) / 180);
  return (Math.max(region.latitudeDelta, region.longitudeDelta * k) * M_PER_DEG) / side;
}

// ── Map pins and zoom ───────────────────────────────────────────────────────────────────

/**
 * Where a custom marker view `height` points tall sits so the point `tipY` points down from its
 * top (horizontally centred) lands on the coordinate, for both map engines: Google Maps reads `anchor` (a fraction of
 * the view), Apple Maps centres the view on the coordinate and reads `centerOffset` (points,
 * negative moves it up). Each engine ignores the other's prop, so a marker passes both.
 */
export function tipAnchor(height: number, tipY: number): { anchor: { x: number; y: number }; centerOffset: { x: number; y: number } } {
  return { anchor: { x: 0.5, y: tipY / height }, centerOffset: { x: 0, y: height / 2 - tipY } };
}

/**
 * The longitude span a square map shows when it frames `region`: the region's own width, or its
 * height turned into the same Mercator scale when the height is what has to fit.
 */
export function fittedSpan(region: Region): number {
  const k = Math.cos((region.latitude * Math.PI) / 180);
  return Math.max(region.longitudeDelta, k > 0 ? region.latitudeDelta / k : region.latitudeDelta);
}

/** How far the map may drift from the view it opened on before Recenter shows: a tenth of that view. */
export const AWAY_SHARE = 0.1;

/**
 * Whether the map has been moved or zoomed off the view it opened on (`fitted`): its centre more
 * than a tenth of that view's width away, or its zoom more than a tenth in or out. The engine's own
 * settling (it rounds the opening view to the square) stays within that.
 */
export function awayFrom(current: Region, fitted: Region): boolean {
  const span = fittedSpan(fitted);
  if (!(span > 0)) return false;
  const k = Math.cos((fitted.latitude * Math.PI) / 180) || 1;
  const moved = Math.hypot(current.latitude - fitted.latitude, (current.longitude - fitted.longitude) * k) / k;
  const zoom = Math.abs(Math.log(fittedSpan(current) / span));
  return moved > span * AWAY_SHARE || zoom > Math.log(1 + AWAY_SHARE);
}

/** Whether two views are at the same zoom (within 2 %), so a pan alone redraws nothing. */
export const sameZoom = (a: Region, b: Region): boolean => Math.abs(Math.log(fittedSpan(a) / fittedSpan(b))) < 0.02;
