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

export interface SpeedLimitApi {
  /** One request for 1..4 z15 tiles (`GET speed-limits?tiles=…`). */
  getTiles(keys: string[]): Promise<TileBatchResponse>;
  /** One point lookup (`POST speed-limits`). Only worth making when a batch said `fallback: 'aws'`. */
  lookupPoint(req: PointRequest | PointRequestInput): Promise<PointResponse>;
}

/** The slice of `SupabaseClient` this needs — the real client satisfies it (tested). */
export interface SpeedLimitsSupabase {
  functions: {
    invoke(
      name: string,
      options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; timeout?: number }
    ): Promise<{ data: unknown; error: unknown }>;
  };
}

export function createSupabaseSpeedLimitApi(supabase: SpeedLimitsSupabase): SpeedLimitApi {
  return {
    async getTiles(keys) {
      const valid = TileKeysSchema.parse(keys);
      // Keys are `15/x/y`: slashes and commas are legal in a query string, and the server reads
      // the parameter with URLSearchParams, so they are sent as they are.
      const { data, error } = await supabase.functions.invoke(
        `${SPEED_LIMITS_FUNCTION}?tiles=${valid.join(',')}`,
        { method: 'GET', timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS }
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
