/** @jest-environment node */
import trace from '@/core/__fixtures__/traces/speeding-corrected.json';
import {
  parseTileKey,
  prefetchSet,
  TILE_LOOKAHEAD_M,
  tileBounds,
  tileFor,
  tileKey,
  type TileXY,
} from '@/core/speedLimits/tiles';
import { MAX_TILES_PER_REQUEST, TILE_ZOOM } from '@/core/speedLimits/wire';

const M_PER_DEG = 111_320;
const keys = (ts: TileXY[]): string[] => ts.map(tileKey);
const cosLat = (lat: number): number => Math.cos((lat * Math.PI) / 180);

/** A point `m` metres inside a tile edge. */
const lngInsideEast = (t: TileXY, lat: number, m: number): number =>
  tileBounds(t).maxLng - m / (M_PER_DEG * cosLat(lat));
const latInsideNorth = (t: TileXY, m: number): number => tileBounds(t).maxLat - m / M_PER_DEG;
const latInsideSouth = (t: TileXY, m: number): number => tileBounds(t).minLat + m / M_PER_DEG;
const midLat = (t: TileXY): number => (tileBounds(t).minLat + tileBounds(t).maxLat) / 2;
const midLng = (t: TileXY): number => (tileBounds(t).minLng + tileBounds(t).maxLng) / 2;

describe('tileFor / tileKey at the fixture corridor', () => {
  it('uses zoom 15 by default and the standard slippy-map numbering', () => {
    expect(TILE_ZOOM).toBe(15);
    expect(tileFor(47.6062, -122.3321)).toEqual({ z: 15, x: 5249, y: 11443 });
    expect(tileFor(47.6062, -122.3009042)).toEqual({ z: 15, x: 5251, y: 11443 });
    expect(tileKey({ z: 15, x: 5249, y: 11443 })).toBe('15/5249/11443');
    expect(tileFor(0, 0, 1)).toEqual({ z: 1, x: 1, y: 1 });
  });

  it('the speeding-corrected trace crosses exactly three z15 tiles', () => {
    const seen = new Set(trace.rows.map((r) => tileKey(tileFor(r.lat, r.lng))));
    expect([...seen].sort()).toEqual(['15/5249/11443', '15/5250/11443', '15/5251/11443']);
  });

  it('a z15 tile at the corridor is about 0.82 km across', () => {
    const b = tileBounds(tileFor(47.6062, -122.32));
    const widthM = (b.maxLng - b.minLng) * M_PER_DEG * cosLat(47.6062);
    const heightM = (b.maxLat - b.minLat) * M_PER_DEG;
    expect(widthM).toBeGreaterThan(800);
    expect(widthM).toBeLessThan(840);
    expect(heightM).toBeGreaterThan(800);
    expect(heightM).toBeLessThan(840);
  });

  it('tile bounds contain the point that produced the tile', () => {
    const b = tileBounds(tileFor(47.6062, -122.32));
    expect(47.6062).toBeGreaterThanOrEqual(b.minLat);
    expect(47.6062).toBeLessThan(b.maxLat);
    expect(-122.32).toBeGreaterThanOrEqual(b.minLng);
    expect(-122.32).toBeLessThan(b.maxLng);
  });

  it('clamps the poles and wraps nothing past the antimeridian', () => {
    expect(tileFor(89.9, 0).y).toBe(0);
    expect(tileFor(-89.9, 0).y).toBe(2 ** 15 - 1);
    expect(tileFor(0, 180).x).toBe(2 ** 15 - 1);
    expect(tileFor(0, -180).x).toBe(0);
  });
});

describe('parseTileKey', () => {
  it('accepts a z15 key in range', () => {
    expect(parseTileKey('15/5249/11443')).toEqual({ z: 15, x: 5249, y: 11443 });
  });

  it.each(['14/5249/11443', '15/32768/1', '15/1/32768', '15/-1/2', '15/1.5/2', '15/01/2', ' 15/1/2', '15/1/2/3', ''])(
    'refuses %p',
    (key) => {
      expect(parseTileKey(key)).toBeNull();
    }
  );
});

describe('prefetchSet (rev1: I6)', () => {
  it('holds at most four distinct z15 tiles, the current one first', () => {
    for (const course of [0, 37, 90, 135, 180, 225, 270, 315]) {
      const set = prefetchSet(47.6062, -122.3321, course);
      expect(set.length).toBeGreaterThanOrEqual(2);
      expect(set.length).toBeLessThanOrEqual(MAX_TILES_PER_REQUEST);
      expect(new Set(keys(set)).size).toBe(set.length);
      expect(set.every((t) => t.z === 15)).toBe(true);
      expect(set[0]).toEqual(tileFor(47.6062, -122.3321));
    }
  });

  it('at the trace start, heading east 4 m north of a tile row edge: current, next, and both lateral tiles', () => {
    expect(keys(prefetchSet(47.6062, -122.3321, 90))).toEqual([
      '15/5249/11443',
      '15/5250/11443',
      '15/5249/11444',
      '15/5250/11444',
    ]);
  });

  it('returns the next tile along course well before the boundary is reached', () => {
    const t = tileFor(47.6062, -122.32);
    const lat = midLat(t);
    const lng = lngInsideEast(t, lat, 500); // 500 m short of the east edge, heading east
    const set = keys(prefetchSet(lat, lng, 90));
    expect(set[0]).toBe(tileKey(t));
    expect(set).toContain(tileKey({ ...t, x: t.x + 1 }));
    expect(TILE_LOOKAHEAD_M).toBe(1200);
  });

  it('looks past the 1000 m prefetch interval: two edges within 1200 m are both requested', () => {
    const t = tileFor(47.6062, -122.32);
    const lat = midLat(t);
    // 300 m short of the east edge: the edges ahead are at ~300 m and ~1120 m.
    const set = keys(prefetchSet(lat, lngInsideEast(t, lat, 300), 90));
    expect(set).toContain(tileKey({ ...t, x: t.x + 1 }));
    expect(set).toContain(tileKey({ ...t, x: t.x + 2 }));
  });

  it('heading west, the next tile is the western neighbour', () => {
    const t = tileFor(47.6062, -122.32);
    const set = keys(prefetchSet(midLat(t), tileBounds(t).minLng + 300 / (M_PER_DEG * cosLat(47.6)), 270));
    expect(set).toContain(tileKey({ ...t, x: t.x - 1 }));
    expect(set).not.toContain(tileKey({ ...t, x: t.x + 1 }));
  });

  it('adds the lateral neighbour on the side of the nearest tile edge', () => {
    const t = tileFor(47.6062, -122.32);
    const lng = midLng(t);
    const nearNorth = keys(prefetchSet(latInsideNorth(t, 50), lng, 90));
    expect(nearNorth).toContain(tileKey({ ...t, y: t.y - 1 }));
    expect(nearNorth).not.toContain(tileKey({ ...t, y: t.y + 1 }));

    const nearSouth = keys(prefetchSet(latInsideSouth(t, 50), lng, 90));
    expect(nearSouth).toContain(tileKey({ ...t, y: t.y + 1 }));
    expect(nearSouth).not.toContain(tileKey({ ...t, y: t.y - 1 }));
  });

  it('heading north near an east edge, the lateral neighbour is to the east', () => {
    const t = tileFor(47.6062, -122.32);
    const lat = midLat(t);
    const set = keys(prefetchSet(lat, lngInsideEast(t, lat, 40), 0));
    expect(set).toContain(tileKey({ ...t, y: t.y - 1 }));
    expect(set).toContain(tileKey({ ...t, x: t.x + 1 }));
  });

  it('on a diagonal it holds the tiles the course actually passes through, in order', () => {
    const t = tileFor(47.6062, -122.32);
    // 100 m from the east edge and 300 m from the north edge, heading north-east: the course
    // leaves through the east edge first, then crosses the north edge of the eastern tile.
    const lat = latInsideNorth(t, 300);
    const set = keys(prefetchSet(lat, lngInsideEast(t, lat, 100), 45));
    const east = tileKey({ ...t, x: t.x + 1 });
    const northEast = tileKey({ ...t, x: t.x + 1, y: t.y - 1 });
    expect(set).toContain(east);
    expect(set).toContain(northEast);
    expect(set.indexOf(east)).toBeLessThan(set.indexOf(northEast));
  });

  it('normalises a course past 360 (450 = 810 = 90)', () => {
    const a = keys(prefetchSet(47.6062, -122.3321, 90));
    expect(keys(prefetchSet(47.6062, -122.3321, 450))).toEqual(a);
    expect(keys(prefetchSet(47.6062, -122.3321, 810))).toEqual(a);
  });

  it('with no usable course, returns the 2x2 block of tiles nearest the point', () => {
    const expected = ['15/5249/11443', '15/5248/11443', '15/5249/11444', '15/5248/11444'];
    for (const course of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(keys(prefetchSet(47.6062, -122.3321, course)).sort()).toEqual([...expected].sort());
      expect(prefetchSet(47.6062, -122.3321, course)[0]).toEqual({ z: 15, x: 5249, y: 11443 });
    }
  });
});
