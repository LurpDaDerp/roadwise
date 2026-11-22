/** @jest-environment node */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createSupabaseSpeedLimitApi,
  SPEED_LIMIT_REQUEST_TIMEOUT_MS,
  type SpeedLimitsSupabase,
} from '@/core/speedLimits/api';
import { createPumpedTimers } from '@/lib/timers';

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
      signal: expect.any(AbortSignal),
    });
  });

  it('fresh: a one-off value in the query (no cache entry can match) and Cache-Control: no-cache; the server reads only tiles', async () => {
    const { supabase, invoke } = fake({ data: batch, error: null });
    const api = createSupabaseSpeedLimitApi(supabase);
    await expect(api.getTiles(['15/5249/11443'], { fresh: true })).resolves.toEqual(batch);
    await api.getTiles(['15/5249/11443'], { fresh: true });
    const [first, second] = invoke.mock.calls.map((c) => c[0]);
    expect(first).toMatch(/^speed-limits\?tiles=15\/5249\/11443&fresh=[0-9a-z]+$/);
    expect(second).not.toBe(first);
    expect(new URLSearchParams(first!.split('?')[1]).getAll('tiles')).toEqual(['15/5249/11443']);
    expect(invoke.mock.calls[0]![1]).toEqual({ method: 'GET', headers: { 'Cache-Control': 'no-cache' }, timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS, signal: expect.any(AbortSignal) });
    // Without it (or with fresh false) the request is the ordinary, cacheable one.
    await api.getTiles(['15/5249/11443'], { fresh: false });
    expect(invoke.mock.calls[2]).toEqual(['speed-limits?tiles=15/5249/11443', { method: 'GET', timeout: SPEED_LIMIT_REQUEST_TIMEOUT_MS, signal: expect.any(AbortSignal) }]);
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
      signal: expect.any(AbortSignal),
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

describe('the time-out (Android pauses plain JS timers while RoadWise is behind)', () => {
  /** Pumped timers whose plain JS timer never fires: only a pump (a drive's row) can fire them. */
  function behind() {
    let t = 0;
    const timers = createPumpedTimers({ now: () => t, setTimeout: () => null, clearTimeout: () => {} });
    return { timers, at: (ms: number) => (t = ms) };
  }
  /** A call that never answers (a stalled request, or a session read waiting on a paused refresh). */
  function hung() {
    const signals: AbortSignal[] = [];
    const invoke = jest.fn((_name: string, options: { signal?: AbortSignal }) => {
      signals.push(options.signal!);
      return new Promise<{ data: unknown; error: unknown }>(() => {});
    });
    return { supabase: { functions: { invoke } }, signals };
  }
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true)
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    return done;
  };

  it.each([
    ['getTiles', (api: ReturnType<typeof createSupabaseSpeedLimitApi>) => api.getTiles(['15/5249/11443'])],
    ['lookupPoint', (api: ReturnType<typeof createSupabaseSpeedLimitApi>) => api.lookupPoint({ lat: 47.6, lng: -122.3, heading: 90 })],
  ])('%s: a call that never answers is aborted and rejected once the time-out is due, by a pump alone', async (_name, call) => {
    const { timers, at } = behind();
    const { supabase, signals } = hung();
    const pending = call(createSupabaseSpeedLimitApi(supabase, timers));
    void pending.catch(() => {});
    at(SPEED_LIMIT_REQUEST_TIMEOUT_MS - 1);
    timers.pump();
    expect(await settled(pending)).toBe(false);
    expect(signals[0]!.aborted).toBe(false);

    at(SPEED_LIMIT_REQUEST_TIMEOUT_MS);
    timers.pump();
    await expect(pending).rejects.toThrow(/did not answer within 15000 ms/);
    expect(signals[0]!.aborted).toBe(true);
    expect(timers.pending()).toBe(0);
  });

  it('a call that answers, or fails, leaves no timer behind', async () => {
    const timers = createPumpedTimers({ setTimeout: () => null, clearTimeout: () => {} });
    await createSupabaseSpeedLimitApi(fake({ data: batch, error: null }).supabase, timers).getTiles(['15/5249/11443']);
    expect(timers.pending()).toBe(0);
    await expect(createSupabaseSpeedLimitApi(fake({ data: null, error: new Error('x') }).supabase, timers).getTiles(['15/5249/11443'])).rejects.toThrow('x');
    expect(timers.pending()).toBe(0);
  });
});
