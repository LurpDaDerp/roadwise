// The device's two calls to the `speed-limits` edge function (design §4.4; plan rev1: I6).
//
// DEVICE ONLY. Not mirrored to the edge function (`scripts/sync-scoring.js` copies `wire`, `tiles`,
// `geometry` and `match` by explicit list; this file must never join it).
//
// Both directions are validated against the shared wire contract: a request this build would send
// wrongly is refused before it costs a network call, and a reply that breaks the contract is
// refused rather than half-applied — the caller reports it and treats the tiles as not fetched.

import {
  type PointRequest,
  type PointRequestInput,
  PointRequestSchema,
  type PointResponse,
  PointResponseSchema,
  type TileBatchResponse,
  TileBatchResponseSchema,
  TileKeysSchema,
} from './wire';

export const SPEED_LIMITS_FUNCTION = 'speed-limits';

/**
 * A request that has not answered by now is abandoned. The client holds its tile keys "in flight"
 * until the request settles, so a hung request must not hold them for the rest of the drive.
 */
export const SPEED_LIMIT_REQUEST_TIMEOUT_MS = 15_000;

/** How one tile request is made. */
export interface TileRequestOptions {
  /**
   * Never answered from an HTTP cache: a request for a tile the server sent `filling`. The URL
   * carries a one-off `fresh` value (no cache entry can match it) and the request says
   * `Cache-Control: no-cache`, so a cached "filling" reply can never stand in for the new answer.
   */
  fresh?: boolean;
}

let freshSeq = 0;
/** A value no earlier request carried. */
const freshToken = (): string => `${Date.now().toString(36)}${(freshSeq += 1).toString(36)}`;

export interface SpeedLimitApi {
  /** One request for 1..4 z15 tiles (`GET speed-limits?tiles=…`). */
  getTiles(keys: string[], opts?: TileRequestOptions): Promise<TileBatchResponse>;
  /** One point lookup (`POST speed-limits`). Only worth making when a batch said `fallback: 'aws'`. */
  lookupPoint(req: PointRequest | PointRequestInput): Promise<PointResponse>;
}

/** The slice of `SupabaseClient` this needs — the real client satisfies it (tested). */
export interface SpeedLimitsSupabase {
  functions: {
    invoke(
      name: string,
      options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; headers?: Record<string, string>; timeout?: number }
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

export function createSupabaseSpeedLimitApi(supabase: SpeedLimitsSupabase): SpeedLimitApi {
  return {
    async getTiles(keys, opts = {}) {
      const valid = TileKeysSchema.parse(keys);
      // Keys are `15/x/y`: slashes and commas are legal in a query string, and the server reads
      // the parameter with URLSearchParams, so they are sent as they are. The server reads only
      // `tiles`; `fresh` is there to miss every HTTP cache entry.
      const fresh = opts.fresh === true;
      const query = `tiles=${valid.join(',')}${fresh ? `&fresh=${freshToken()}` : ''}`;
      const { data, error } = await supabase.functions.invoke(
        `${SPEED_LIMITS_FUNCTION}?${query}`,
        fresh
          ? { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS }
          : { method: 'GET', timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS }
      );
      if (error) throw error;
      return TileBatchResponseSchema.parse(data);
    },

    async lookupPoint(req) {
      const body = PointRequestSchema.parse(req);
      const { data, error } = await supabase.functions.invoke(SPEED_LIMITS_FUNCTION, {
        method: 'POST',
        body,
        timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS,
      });
      if (error) throw error;
      return PointResponseSchema.parse(data);
    },
  };
}
