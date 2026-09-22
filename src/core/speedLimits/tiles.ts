// Slippy-map tile math for the speed-limit tiles (plan rev1: I6).
//
// Shared with the `speed-limits` edge function (mirrored by `scripts/sync-scoring.js`): imports
// only its siblings, so it runs unchanged under Jest and Deno.
//
// Everything is done in continuous tile space (Web Mercator scaled so one tile is one unit),
// where the tile grid is a plain integer lattice and a straight course is a straight line — so
// "which tiles does the next 1200 m pass through" is an exact grid traversal, not a sampling.

import type { BBox } from './geometry';
import { normalizeDeg } from './geometry';
import { MAX_TILES_PER_REQUEST, TILE_KEY_RE, TILE_ZOOM } from './wire';

export interface TileXY {
  z: number;
  x: number;
  y: number;
}

/**
 * How far ahead along the course `prefetchSet` looks. A z15 tile is ~0.82 km across at 47.6° N,
 * so the lookahead always reaches the next tile on a straight course (rev1: I6). It is longer than
 * the engine's 1000 m prefetch interval (controller ruling on S1 concern 4), so on a straight course
 * every tile entered before the next prefetch fires was already in this one.
 */
export const TILE_LOOKAHEAD_M = 1200;

const DEG = Math.PI / 180;
const MAX_LAT = 85.05112878; // Web Mercator's limit
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Continuous tile coordinates of a point: the integer part is the tile, the rest the position in it. */
function tileSpace(lat: number, lng: number, z: number): { fx: number; fy: number } {
  const n = 2 ** z;
  const r = clamp(lat, -MAX_LAT, MAX_LAT) * DEG;
  return {
    fx: ((lng + 180) / 360) * n,
    fy: ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n,
  };
}

export function tileFor(lat: number, lng: number, z: number = TILE_ZOOM): TileXY {
  const n = 2 ** z;
  const { fx, fy } = tileSpace(lat, lng, z);
  return { z, x: clamp(Math.floor(fx), 0, n - 1), y: clamp(Math.floor(fy), 0, n - 1) };
}

export function tileKey(t: TileXY): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** The inverse of `tileKey` for z15 keys; `null` for anything malformed or off the grid. */
export function parseTileKey(key: string): TileXY | null {
  const m = TILE_KEY_RE.exec(key);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const n = 2 ** TILE_ZOOM;
  return x < n && y < n ? { z: TILE_ZOOM, x, y } : null;
}

const latOfRow = (y: number, n: number): number => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;

/** A tile's extent in degrees (north edge = `maxLat`). */
export function tileBounds(t: TileXY): BBox {
  const n = 2 ** t.z;
  return {
    minLat: latOfRow(t.y + 1, n),
    maxLat: latOfRow(t.y, n),
    minLng: (t.x / n) * 360 - 180,
    maxLng: ((t.x + 1) / n) * 360 - 180,
  };
}

/** A unit direction in tile space for a compass bearing (tile y grows southward). */
const dirOf = (bearingDeg: number): { dx: number; dy: number } => ({
  dx: Math.sin(bearingDeg * DEG),
  dy: -Math.cos(bearingDeg * DEG),
});

/** Distance (tile units) along a ray from (fx, fy) to its first cell edge, and the cell step taken there. */
function firstExit(fx: number, fy: number, dx: number, dy: number): { t: number; sx: number; sy: number } {
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const tx = dx > 0 ? (cx + 1 - fx) / dx : dx < 0 ? (fx - cx) / -dx : Infinity;
  const ty = dy > 0 ? (cy + 1 - fy) / dy : dy < 0 ? (fy - cy) / -dy : Infinity;
  return tx <= ty ? { t: tx, sx: Math.sign(dx), sy: 0 } : { t: ty, sx: 0, sy: Math.sign(dy) };
}

/** Every cell a ray of `len` tile units passes through, in order, starting with its own cell. */
function traverse(fx: number, fy: number, dx: number, dy: number, len: number): [number, number][] {
  let cx = Math.floor(fx);
  let cy = Math.floor(fy);
  const cells: [number, number][] = [[cx, cy]];
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let tMaxX = dx > 0 ? (cx + 1 - fx) / dx : dx < 0 ? (fx - cx) / -dx : Infinity;
  let tMaxY = dy > 0 ? (cy + 1 - fy) / dy : dy < 0 ? (fy - cy) / -dy : Infinity;
  const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  // A 1200 m ray crosses at most a handful of z15 edges; the bound only guards degenerate input.
  for (let guard = 0; guard < 64 && Math.min(tMaxX, tMaxY) <= len; guard += 1) {
    if (tMaxX <= tMaxY) {
      cx += sx;
      tMaxX += tDeltaX;
    } else {
      cy += sy;
      tMaxY += tDeltaY;
    }
    cells.push([cx, cy]);
  }
  return cells;
}

/**
 * The tiles to request in one batch (rev1: I6), current tile first, de-duplicated, at most
 * `MAX_TILES_PER_REQUEST`:
 *   1. the current tile;
 *   2. the next tile along the course (the first edge crossed within `TILE_LOOKAHEAD_M`);
 *   3. the lateral neighbour of the current tile, across whichever edge is nearer when moving
 *      perpendicular to the course (left or right) — the tile a road hugging that edge wanders into;
 *   4. the spare: any further tile the course passes through within the lookahead (a diagonal
 *      course, or one starting just short of an edge), else the next tile's lateral neighbour on
 *      the same side.
 *
 * With no usable course (negative — the platforms' "unknown" — or non-finite), the 2x2 block of
 * tiles nearest the point: everything within half a tile of it in any direction.
 */
export function prefetchSet(lat: number, lng: number, courseDeg: number): TileXY[] {
  const z = TILE_ZOOM;
  const n = 2 ** z;
  const t0 = tileFor(lat, lng, z);
  const raw = tileSpace(lat, lng, z);
  // Keep the position inside the current tile (it can sit on the grid's outer edge after clamping).
  const fx = clamp(raw.fx, t0.x, t0.x + 1 - 1e-9);
  const fy = clamp(raw.fy, t0.y, t0.y + 1 - 1e-9);

  const cells: [number, number][] = [];
  if (!Number.isFinite(courseDeg) || courseDeg < 0) {
    const sx = fx - t0.x < 0.5 ? -1 : 1;
    const sy = fy - t0.y < 0.5 ? -1 : 1;
    cells.push([t0.x, t0.y], [t0.x + sx, t0.y], [t0.x, t0.y + sy], [t0.x + sx, t0.y + sy]);
  } else {
    const course = normalizeDeg(courseDeg);
    const metresPerUnit = (EARTH_CIRCUMFERENCE_M * Math.cos(clamp(lat, -MAX_LAT, MAX_LAT) * DEG)) / n;
    const { dx, dy } = dirOf(course);
    const along = traverse(fx, fy, dx, dy, TILE_LOOKAHEAD_M / metresPerUnit);

    const right = dirOf(course + 90);
    const left = dirOf(course - 90);
    const exitRight = firstExit(fx, fy, right.dx, right.dy);
    const exitLeft = firstExit(fx, fy, left.dx, left.dy);
    const side = exitRight.t <= exitLeft.t ? exitRight : exitLeft;

    cells.push(along[0] as [number, number]);
    if (along[1]) cells.push(along[1]);
    cells.push([t0.x + side.sx, t0.y + side.sy]);
    cells.push(...along.slice(2));
    if (along[1]) cells.push([along[1][0] + side.sx, along[1][1] + side.sy]);
  }

  const out: TileXY[] = [];
  const seen = new Set<string>();
  for (const [cx, cy] of cells) {
    if (cy < 0 || cy >= n) continue; // off the top or bottom of the map
    const t = { z, x: ((cx % n) + n) % n, y: cy }; // wraps at the antimeridian
    const key = tileKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TILES_PER_REQUEST) break;
  }
  return out;
}
