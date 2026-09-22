/** @jest-environment node */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createSupabaseSpeedLimitApi,
  SPEED_LIMIT_REQUEST_TIMEOUT_MS,
  type SpeedLimitsSupabase,
} from '@/core/speedLimits/api';

// The real client must satisfy the narrow seam the api takes.
const _compat: SpeedLimitsSupabase = null as unknown as SupabaseClient;
void _compat;

const batch = {
  tiles: [{ tile: '15/5249/11443', expiresAt: 1_800_000_000_000, truncated: false, segments: [] }],
  fallback: null,
};

function fake(reply: { data: unknown; error: unknown }) {
  const invoke = jest.fn(async (_name: string, _options: Record<string, unknown>) => reply);
  return { supabase: { functions: { invoke } }, invoke };
}

describe('getTiles', () => {
  it('sends one GET with the keys in the query and a timeout, and returns the parsed batch', async () => {
    const { supabase, invoke } = fake({ data: batch, error: null });
    const api = createSupabaseSpeedLimitApi(supabase);
    await expect(api.getTiles(['15/5249/11443', '15/5250/11443'])).resolves.toEqual(batch);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('speed-limits?tiles=15/5249/11443,15/5250/11443', {
      method: 'GET',
      timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS,
    });
  });

  it('refuses bad keys before touching the network', async () => {
    const { supabase, invoke } = fake({ data: batch, error: null });
    const api = createSupabaseSpeedLimitApi(supabase);
    await expect(api.getTiles([])).rejects.toThrow();
    await expect(api.getTiles(['14/1/1'])).rejects.toThrow();
    await expect(api.getTiles(['15/1/1', '15/1/2', '15/1/3', '15/1/4', '15/1/5'])).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a reply that breaks the contract', async () => {
    const bad = { ...batch, tiles: [{ ...batch.tiles[0], extra: 1 }] };
    const api = createSupabaseSpeedLimitApi(fake({ data: bad, error: null }).supabase);
    await expect(api.getTiles(['15/5249/11443'])).rejects.toThrow();
    const noFallback = { tiles: batch.tiles };
    const api2 = createSupabaseSpeedLimitApi(fake({ data: noFallback, error: null }).supabase);
    await expect(api2.getTiles(['15/5249/11443'])).rejects.toThrow();
  });

  it('throws the function error', async () => {
    const error = new Error('FunctionsHttpError');
    const api = createSupabaseSpeedLimitApi(fake({ data: null, error }).supabase);
    await expect(api.getTiles(['15/5249/11443'])).rejects.toBe(error);
  });
});

describe('lookupPoint', () => {
  const answer = { limitMph: 40, source: 'cached', matchConfidence: 0.7, parallelRoads: false, provider: 'aws' };

  it('POSTs the validated request with the default radius', async () => {
    const { supabase, invoke } = fake({ data: answer, error: null });
    const api = createSupabaseSpeedLimitApi(supabase);
    await expect(api.lookupPoint({ lat: 47.6, lng: -122.3, heading: 90 })).resolves.toEqual(answer);
    expect(invoke).toHaveBeenCalledWith('speed-limits', {
      method: 'POST',
      body: { lat: 47.6, lng: -122.3, heading: 90, radiusM: 25 },
      timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS,
    });
  });

  it('refuses an unknown heading before touching the network', async () => {
    const { supabase, invoke } = fake({ data: answer, error: null });
    await expect(createSupabaseSpeedLimitApi(supabase).lookupPoint({ lat: 47.6, lng: -122.3, heading: -1 })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a reply that contradicts itself', async () => {
    const dishonest = { ...answer, source: 'unknown' };
    const api = createSupabaseSpeedLimitApi(fake({ data: dishonest, error: null }).supabase);
    await expect(api.lookupPoint({ lat: 47.6, lng: -122.3, heading: 90 })).rejects.toThrow();
  });
});
