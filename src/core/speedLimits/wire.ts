// The `speed-limits` wire contract (design §4.4; plan rev1: I6).
//
// One source for both ends: the device validates what it receives against these schemas and the
// edge function validates what it sends against a byte-identical copy in
// `supabase/functions/_shared/` (mirrored by `scripts/sync-scoring.js`). So this file imports only
// `zod` — no `@/` alias, no React Native, no Node built-ins — and runs unchanged under Deno.
//
// Every object is strict: a key the contract does not know is drift between the two ends.

import { z } from 'zod';

/** Tiles are slippy-map z15: about 0.82 km across at Seattle's latitude. */
export const TILE_ZOOM = 15;
/** A stored tile never outlives this, whatever `expiresAt` the server sent. */
export const MAX_TILE_TTL_MS = 30 * 24 * 3600 * 1000;
/** One batch request carries at most this many tiles (rev1: I6). */
export const MAX_TILES_PER_REQUEST = 4;
/** The server truncates a tile at this many segments and says so. */
export const MAX_SEGMENTS_PER_TILE = 2000;

/** `15/x/y` with canonical integers (no sign, no leading zeros); the range is checked separately. */
export const TILE_KEY_RE = /^15\/(0|[1-9]\d{0,4})\/(0|[1-9]\d{0,4})$/;

const TILE_COUNT = 2 ** TILE_ZOOM;

/** A z15 tile key whose x and y are inside the 2^15 grid. */
export const TileKeySchema = z.string().refine((key) => {
  const m = TILE_KEY_RE.exec(key);
  return m !== null && Number(m[1]) < TILE_COUNT && Number(m[2]) < TILE_COUNT;
}, 'expected a z15 tile key 15/x/y');

const unique = (keys: readonly string[]): boolean => new Set(keys).size === keys.length;

/** The `tiles=` query of a batch request: 1..4 distinct keys. */
export const TileKeysSchema = z
  .array(TileKeySchema)
  .min(1)
  .max(MAX_TILES_PER_REQUEST)
  .refine(unique, 'tile keys must be distinct');

export const ProviderSchema = z.enum(['osm', 'hpms', 'aws']);
export type Provider = z.infer<typeof ProviderSchema>;

/** A posted limit in mph: whole numbers, 5..85 (the tables' CHECK). */
const limitMph = z.number().int().min(5).max(85);

export const LimitSegmentSchema = z
  .object({
    id: z.string().min(1).max(24),
    provider: ProviderSchema,
    /** `null` for an OSM way with no usable `maxspeed` — sent so the matcher can see the road. */
    limitMph: limitMph.nullable(),
    highway: z.string().min(1).max(24),
    oneway: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    /** Google encoded polyline, precision 5, a single LineString. */
    line: z.string().min(1).max(4096),
  })
  .strict();
export type LimitSegment = z.infer<typeof LimitSegmentSchema>;

export const TileSchema = z
  .object({
    tile: TileKeySchema,
    /** Epoch ms. Clients cap it at `now + MAX_TILE_TTL_MS`. */
    expiresAt: z.number().int().nonnegative(),
    /** True when the server hit `MAX_SEGMENTS_PER_TILE` and dropped the rest. */
    truncated: z.boolean(),
    segments: z.array(LimitSegmentSchema).max(MAX_SEGMENTS_PER_TILE),
  })
  .strict();
export type Tile = z.infer<typeof TileSchema>;

export const TileBatchResponseSchema = z
  .object({
    tiles: z
      .array(TileSchema)
      .min(1)
      .max(MAX_TILES_PER_REQUEST)
      .refine((ts) => unique(ts.map((t) => t.tile)), 'tiles must be distinct'),
    /** `'aws'` iff the server can answer a point lookup beyond its tiles (rev1: I6). */
    fallback: z.literal('aws').nullable(),
  })
  .strict();
export type TileBatchResponse = z.infer<typeof TileBatchResponseSchema>;

export const PointRequestSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    /** The car's course, degrees clockwise from north. An unknown course is never sent. */
    heading: z.number().min(0).lt(360),
    radiusM: z.number().int().min(5).max(50).default(25),
  })
  .strict();
export type PointRequest = z.infer<typeof PointRequestSchema>;
export type PointRequestInput = z.input<typeof PointRequestSchema>;

export const PointSourceSchema = z.enum(['posted', 'statutory', 'cached', 'unknown']);
export type PointSource = z.infer<typeof PointSourceSchema>;

export const PointResponseSchema = z
  .object({
    limitMph: limitMph.nullable(),
    /** `statutory` is never produced in M3 (R17) but stays in the contract for the server. */
    source: PointSourceSchema,
    matchConfidence: z.number().min(0).max(1),
    parallelRoads: z.boolean(),
    provider: ProviderSchema.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    // Honesty at the contract: an unknown answer carries no number, and a known one always does.
    if (r.source === 'unknown') {
      if (r.limitMph !== null) ctx.addIssue({ code: 'custom', message: 'unknown carries no limit', path: ['limitMph'] });
      if (r.provider !== null) ctx.addIssue({ code: 'custom', message: 'unknown names no provider', path: ['provider'] });
      return;
    }
    if (r.limitMph === null) ctx.addIssue({ code: 'custom', message: `${r.source} needs a limit`, path: ['limitMph'] });
    if (r.source === 'posted' && r.provider !== 'osm' && r.provider !== 'hpms') {
      ctx.addIssue({ code: 'custom', message: 'posted comes from open data', path: ['provider'] });
    }
    if (r.source === 'cached' && r.provider !== 'aws') {
      ctx.addIssue({ code: 'custom', message: 'cached comes from the AWS cache', path: ['provider'] });
    }
  });
export type PointResponse = z.infer<typeof PointResponseSchema>;

/** A tile segment's source is derived from its provider on the client: open data is posted. */
export const sourceOf = (p: Provider): 'posted' | 'cached' => (p === 'aws' ? 'cached' : 'posted');
