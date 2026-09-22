/** @jest-environment node */
import {
  LimitSegmentSchema,
  MAX_TILE_TTL_MS,
  MAX_TILES_PER_REQUEST,
  PointRequestSchema,
  PointResponseSchema,
  sourceOf,
  TILE_ZOOM,
  TileBatchResponseSchema,
  TileKeysSchema,
  TileSchema,
} from '@/core/speedLimits/wire';

const segment = {
  id: 'osm:123456789',
  provider: 'osm' as const,
  limitMph: 35,
  highway: 'secondary',
  oneway: 0 as const,
  line: '_p~iF~ps|U_ulLnnqC',
};
const tile = { tile: '15/5249/11443', expiresAt: 1_700_000_000_000, truncated: false, segments: [segment] };
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): boolean =>
  schema.safeParse(v).success;

describe('constants', () => {
  it('are the contract values', () => {
    expect(TILE_ZOOM).toBe(15);
    expect(MAX_TILE_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    expect(MAX_TILES_PER_REQUEST).toBe(4);
  });
});

describe('LimitSegmentSchema', () => {
  it('accepts a segment, and an untagged one with limitMph null', () => {
    expect(ok(LimitSegmentSchema, segment)).toBe(true);
    expect(ok(LimitSegmentSchema, { ...segment, limitMph: null })).toBe(true);
    for (const provider of ['osm', 'hpms', 'aws']) expect(ok(LimitSegmentSchema, { ...segment, provider })).toBe(true);
    for (const oneway of [-1, 0, 1]) expect(ok(LimitSegmentSchema, { ...segment, oneway })).toBe(true);
    expect(ok(LimitSegmentSchema, { ...segment, limitMph: 5 })).toBe(true);
    expect(ok(LimitSegmentSchema, { ...segment, limitMph: 85 })).toBe(true);
  });

  it.each([
    ['an unknown key', { ...segment, source: 'posted' }],
    ['an id over 24 chars', { ...segment, id: 'x'.repeat(25) }],
    ['an empty id', { ...segment, id: '' }],
    ['another provider', { ...segment, provider: 'here' }],
    ['a limit under 5', { ...segment, limitMph: 4 }],
    ['a limit over 85', { ...segment, limitMph: 86 }],
    ['a fractional limit', { ...segment, limitMph: 35.5 }],
    ['a missing limit', (({ limitMph: _l, ...rest }) => rest)(segment)],
    ['a highway over 24 chars', { ...segment, highway: 'h'.repeat(25) }],
    ['oneway 2', { ...segment, oneway: 2 }],
    ['a line over 4096 chars', { ...segment, line: 'a'.repeat(4097) }],
    ['an empty line', { ...segment, line: '' }],
  ])('refuses %s', (_label, value) => {
    expect(ok(LimitSegmentSchema, value)).toBe(false);
  });

  it('accepts ids and lines exactly at their caps', () => {
    expect(ok(LimitSegmentSchema, { ...segment, id: 'x'.repeat(24), line: 'a'.repeat(4096), highway: 'h'.repeat(24) })).toBe(
      true
    );
  });
});

describe('TileSchema', () => {
  it('accepts a tile, including an empty one', () => {
    expect(ok(TileSchema, tile)).toBe(true);
    expect(ok(TileSchema, { ...tile, segments: [] })).toBe(true);
  });

  it('caps segments at 2000', () => {
    expect(ok(TileSchema, { ...tile, truncated: true, segments: Array.from({ length: 2000 }, () => segment) })).toBe(true);
    expect(ok(TileSchema, { ...tile, segments: Array.from({ length: 2001 }, () => segment) })).toBe(false);
  });

  it.each([
    ['another zoom', { ...tile, tile: '14/5249/11443' }],
    ['x out of range', { ...tile, tile: '15/32768/11443' }],
    ['a malformed key', { ...tile, tile: '15/5249' }],
    ['a fractional expiresAt', { ...tile, expiresAt: 1.5 }],
    ['a missing truncated flag', (({ truncated: _t, ...rest }) => rest)(tile)],
    ['an unknown key', { ...tile, source: 'posted' }],
    ['a bad segment', { ...tile, segments: [{ ...segment, limitMph: 90 }] }],
  ])('refuses %s', (_label, value) => {
    expect(ok(TileSchema, value)).toBe(false);
  });
});

describe('TileBatchResponseSchema (rev1: I6)', () => {
  it('accepts 1..4 tiles with fallback aws or null', () => {
    expect(ok(TileBatchResponseSchema, { tiles: [tile], fallback: null })).toBe(true);
    const four = [5249, 5250, 5251, 5252].map((x) => ({ ...tile, tile: `15/${x}/11443` }));
    expect(ok(TileBatchResponseSchema, { tiles: four, fallback: 'aws' })).toBe(true);
  });

  it.each([
    ['no tiles', { tiles: [], fallback: null }],
    ['five tiles', { tiles: [5249, 5250, 5251, 5252, 5253].map((x) => ({ ...tile, tile: `15/${x}/11443` })), fallback: null }],
    ['a repeated tile', { tiles: [tile, tile], fallback: null }],
    ['another fallback', { tiles: [tile], fallback: 'here' }],
    ['a missing fallback', { tiles: [tile] }],
    ['an unknown key', { tiles: [tile], fallback: null, statutory: true }],
  ])('refuses %s', (_label, value) => {
    expect(ok(TileBatchResponseSchema, value)).toBe(false);
  });
});

describe('TileKeysSchema', () => {
  it('accepts 1..4 distinct z15 keys and refuses the rest', () => {
    expect(ok(TileKeysSchema, ['15/5249/11443'])).toBe(true);
    expect(ok(TileKeysSchema, ['15/1/1', '15/1/2', '15/1/3', '15/1/4'])).toBe(true);
    expect(ok(TileKeysSchema, [])).toBe(false);
    expect(ok(TileKeysSchema, ['15/1/1', '15/1/2', '15/1/3', '15/1/4', '15/1/5'])).toBe(false);
    expect(ok(TileKeysSchema, ['15/1/1', '15/1/1'])).toBe(false);
    expect(ok(TileKeysSchema, ['16/1/1'])).toBe(false);
  });
});

describe('PointRequestSchema', () => {
  it('defaults radiusM to 25', () => {
    expect(PointRequestSchema.parse({ lat: 47.6062, lng: -122.32, heading: 90 })).toEqual({
      lat: 47.6062,
      lng: -122.32,
      heading: 90,
      radiusM: 25,
    });
  });

  it('accepts the edges of each range', () => {
    expect(ok(PointRequestSchema, { lat: 47.6, lng: -122.3, heading: 0, radiusM: 5 })).toBe(true);
    expect(ok(PointRequestSchema, { lat: 47.6, lng: -122.3, heading: 359.99, radiusM: 50 })).toBe(true);
  });

  it.each([
    ['heading 360', { lat: 47.6, lng: -122.3, heading: 360 }],
    ['a negative heading (unknown course)', { lat: 47.6, lng: -122.3, heading: -1 }],
    ['radius 4', { lat: 47.6, lng: -122.3, heading: 0, radiusM: 4 }],
    ['radius 51', { lat: 47.6, lng: -122.3, heading: 0, radiusM: 51 }],
    ['a fractional radius', { lat: 47.6, lng: -122.3, heading: 0, radiusM: 25.5 }],
    ['lat 91', { lat: 91, lng: -122.3, heading: 0 }],
    ['lng -181', { lat: 47.6, lng: -181, heading: 0 }],
    ['an unknown key', { lat: 47.6, lng: -122.3, heading: 0, speed: 20 }],
    ['a missing heading', { lat: 47.6, lng: -122.3 }],
  ])('refuses %s', (_label, value) => {
    expect(ok(PointRequestSchema, value)).toBe(false);
  });
});

describe('PointResponseSchema', () => {
  const posted = { limitMph: 35, source: 'posted', matchConfidence: 0.95, parallelRoads: false, provider: 'osm' };
  const unknown = { limitMph: null, source: 'unknown', matchConfidence: 0, parallelRoads: false, provider: null };

  it('accepts posted, cached, unknown — and statutory, which the server contract keeps (R17)', () => {
    expect(ok(PointResponseSchema, posted)).toBe(true);
    expect(ok(PointResponseSchema, { ...posted, provider: 'hpms' })).toBe(true);
    expect(ok(PointResponseSchema, { ...posted, source: 'cached', provider: 'aws', matchConfidence: 0.7 })).toBe(true);
    expect(ok(PointResponseSchema, unknown)).toBe(true);
    expect(ok(PointResponseSchema, { ...posted, source: 'statutory', provider: null })).toBe(true);
  });

  it.each([
    ['unknown carrying a limit', { ...unknown, limitMph: 25 }],
    ['unknown naming a provider', { ...unknown, provider: 'osm' }],
    ['posted without a limit', { ...posted, limitMph: null }],
    ['cached without a limit', { ...posted, source: 'cached', provider: 'aws', limitMph: null }],
    ['posted from the aws cache', { ...posted, provider: 'aws' }],
    ['cached from open data', { ...posted, source: 'cached', provider: 'osm' }],
    ['confidence over 1', { ...posted, matchConfidence: 1.01 }],
    ['negative confidence', { ...posted, matchConfidence: -0.1 }],
    ['a limit over 85', { ...posted, limitMph: 90 }],
    ['another source', { ...posted, source: 'guessed' }],
    ['an unknown key', { ...posted, key: 'osm:1' }],
  ])('refuses %s', (_label, value) => {
    expect(ok(PointResponseSchema, value)).toBe(false);
  });
});

describe('sourceOf', () => {
  it('open data is posted, the AWS cache is cached', () => {
    expect(sourceOf('osm')).toBe('posted');
    expect(sourceOf('hpms')).toBe('posted');
    expect(sourceOf('aws')).toBe('cached');
  });
});
