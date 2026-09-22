/** @jest-environment node */
import { encodePolyline } from '@/lib/polyline';
import { candidatesNear, createTileLru, decodeTile, MEMORY_TILES } from '@/core/speedLimits/store';
import type { LimitSegment } from '@/core/speedLimits/wire';

const M_PER_DEG = 111_320;
const LAT = 47.6062;
const KEY = '15/5249/11443';

const seg = (over: Partial<LimitSegment> = {}): LimitSegment => ({
  id: 'w1',
  provider: 'osm',
  limitMph: 35,
  highway: 'primary',
  oneway: 0,
  line: encodePolyline([
    { lat: LAT, lng: -122.333 },
    { lat: LAT, lng: -122.325 },
  ]),
  ...over,
});

describe('decodeTile', () => {
  it('packs every segment into flat typed arrays with a box per segment', () => {
    const t = decodeTile(KEY, 123, [seg(), seg({ id: 'w2', limitMph: null, oneway: 1 })]);
    expect(t).not.toBeNull();
    expect(t!.count).toBe(2);
    expect(t!.coords).toBeInstanceOf(Float64Array);
    expect(t!.coords.length).toBe(8);
    expect(Array.from(t!.offsets)).toEqual([0, 4, 8]);
    expect(t!.boxes.length).toBe(8);
    expect(t!.keys).toEqual(['osm:w1', 'osm:w2']);
    expect(Array.from(t!.limits)).toEqual([35, 0]);
    expect(Array.from(t!.oneways)).toEqual([0, 1]);
    expect(t!.expiresAt).toBe(123);
    expect(t!.bounds.minLng).toBeLessThan(-122.33);
  });

  it('drops a segment that breaks the contract or will not decode, and keeps the rest', () => {
    const t = decodeTile(KEY, 0, [
      seg({ id: 'bad-limit', limitMph: 200 }),
      seg({ id: 'bad-line', line: '??not a polyline' }),
      { nonsense: true },
      seg({ id: 'good' }),
    ]);
    expect(t!.keys).toEqual(['osm:good']);
  });

  it('is null for a corrupt row or a malformed key, so the caller treats the tile as absent', () => {
    expect(decodeTile(KEY, 0, { not: 'an array' })).toBeNull();
    expect(decodeTile('14/1/1', 0, [seg()])).toBeNull();
  });
});

describe('candidatesNear', () => {
  it('measures only segments whose box is near the point', () => {
    const far = encodePolyline([
      { lat: LAT + 0.01, lng: -122.333 },
      { lat: LAT + 0.01, lng: -122.325 },
    ]);
    const t = decodeTile(KEY, 0, [seg(), seg({ id: 'far', line: far })])!;
    const p = { lat: LAT + 5 / M_PER_DEG, lng: -122.33 };
    const cs = candidatesNear([t], p, 25);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ key: 'osm:w1', provider: 'osm', limitMph: 35, highway: 'primary', oneway: 0 });
    expect(cs[0]!.distanceM).toBeCloseTo(5, 0);
    expect(cs[0]!.bearingDeg).toBeCloseTo(90, 0);
  });

  it('reports an untagged road with a null limit', () => {
    const t = decodeTile(KEY, 0, [seg({ limitMph: null })])!;
    expect(candidatesNear([t], { lat: LAT, lng: -122.33 }, 25)[0]!.limitMph).toBeNull();
  });

  it('lists a road clipped into two tiles once, at its nearer distance', () => {
    const a = decodeTile(KEY, 0, [seg()])!;
    const nearer = encodePolyline([
      { lat: LAT + 2 / M_PER_DEG, lng: -122.333 },
      { lat: LAT + 2 / M_PER_DEG, lng: -122.325 },
    ]);
    const b = decodeTile('15/5249/11444', 0, [seg({ line: nearer })])!;
    const cs = candidatesNear([a, b], { lat: LAT + 8 / M_PER_DEG, lng: -122.33 }, 25);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.distanceM).toBeCloseTo(6, 0);
  });

  it('skips a tile that is nowhere near the point', () => {
    const t = decodeTile('15/5300/11400', 0, [seg()])!;
    expect(candidatesNear([t], { lat: LAT, lng: -122.33 }, 25)).toEqual([]);
  });
});

describe('createTileLru', () => {
  const tile = (i: number) => decodeTile(`15/${5000 + i}/11443`, 0, [])!;

  it('holds 12 tiles by default and evicts the least recently used', () => {
    expect(MEMORY_TILES).toBe(12);
    const lru = createTileLru();
    for (let i = 0; i < 12; i += 1) lru.set(tile(i));
    lru.get('15/5000/11443'); // used: now the newest
    lru.set(tile(12));
    expect(lru.size).toBe(12);
    expect(lru.peek('15/5000/11443')).toBeDefined();
    expect(lru.peek('15/5001/11443')).toBeUndefined();
  });

  it('peek does not count as a use', () => {
    const lru = createTileLru(2);
    lru.set(tile(0));
    lru.set(tile(1));
    lru.peek('15/5000/11443');
    lru.set(tile(2));
    expect(lru.peek('15/5000/11443')).toBeUndefined();
  });
});
