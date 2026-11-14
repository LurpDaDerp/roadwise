/**
 * How every Open-Meteo request leaves the phone: straight to api.open-meteo.com first, and through
 * the `weather` edge function when that fails.
 *
 * - Open-Meteo's geo DNS gives each region one of its servers. When the one a phone is given is
 *   down or out of reach (a reset connection, no answer, a 5xx), every weather card would go blank,
 *   so the same request is asked once more through the `weather` edge function, called in a
 *   European region, which asks Open-Meteo from there (a different Open-Meteo server).
 * - The direct request keeps its own time-out (5 s); the edge function gets `FALLBACK_TIMEOUT_MS`
 *   of its own, and is abandoned then whatever it is doing (the session read before the call can
 *   wait on a token refresh that the call's own time-out does not cover). A 2xx, a 429 and any
 *   other 4xx from Open-Meteo are its answer and are never asked again (a 429 is Open-Meteo saying
 *   "not so often", which the drive's weather watch obeys).
 * - The edge function needs a signed-in user: signed out, it is not asked and the caller reads the
 *   direct failure as the failure it already was.
 * - The query is the direct request's own, so the position is the same one-decimal place. It goes
 *   in the POST body, never in the function's URL, so no request log holds it.
 * - An injected `fetch` (tests, the drive host's seam) is the whole transport: no fallback unless
 *   one is injected too.
 * - Never throws: null when neither way gave a response.
 */
import { FunctionRegion } from '@supabase/supabase-js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The second way: the same query through the edge function. Null when it gave no response. */
export type OpenMeteoFallback = (query: string, timeoutMs: number) => Promise<Response | null>;

export const WEATHER_FUNCTION = 'weather';
/** The direct request is abandoned after this long, unless the caller says otherwise. */
export const DIRECT_TIMEOUT_MS = 5_000;
/** The edge function call is abandoned after this long (it gives Open-Meteo 6 s itself). */
export const FALLBACK_TIMEOUT_MS = 8_000;

export type TransportDeps = {
  fetch?: FetchLike;
  /** The direct request's time-out. */
  timeoutMs?: number;
  /** Null for none; the edge function by default, unless `fetch` is injected. */
  fallback?: OpenMeteoFallback | null;
};

type ResponseLike = { status: number; json: () => Promise<unknown> };
const isResponse = (v: unknown): v is Response =>
  typeof v === 'object' && v !== null && typeof (v as ResponseLike).status === 'number' && typeof (v as ResponseLike).json === 'function';

/** The `weather` edge function, through the app's Supabase client (loaded only when first needed). */
export const edgeFallback: OpenMeteoFallback = async (query, timeoutMs) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, loaded only when a fallback is needed
    const { supabase } = require('@/data/supabase/client') as typeof import('@/data/supabase/client');
    // Signed out, the gateway would only refuse the call: it is not made.
    const { data: auth } = await supabase.auth.getSession();
    if (auth.session === null) return null;
    const { data, error } = await supabase.functions.invoke(WEATHER_FUNCTION, {
      method: 'POST',
      body: { query },
      region: FunctionRegion.EuCentral1,
      timeout: timeoutMs,
    });
    if (error) {
      // A non-2xx answer (a 429 with its Retry-After, a 502) carries the raw response.
      const context = (error as { context?: unknown }).context;
      return isResponse(context) ? context : null;
    }
    if (data === null || typeof data !== 'object') return null;
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return null;
  }
};

/** One direct request, aborted after `timeoutMs`: its response, or null when it threw or timed out. */
async function direct(doFetch: FetchLike, url: string, timeoutMs: number): Promise<Response | null> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    return await doFetch(url, { signal: control.signal, headers: { Accept: 'application/json' } });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `work`'s value, or null when it throws, rejects or has not settled after `ms`. */
async function within<T>(work: () => Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open-Meteo's response to `url`: the direct one when it answered (2xx or 4xx), else the edge
 * function's, else whatever the direct request got (a 5xx), else null.
 */
export async function requestOpenMeteo(url: string, deps: TransportDeps = {}): Promise<Response | null> {
  const doFetch = deps.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);
  const fallback = deps.fallback !== undefined ? deps.fallback : deps.fetch ? null : edgeFallback;
  const first = typeof doFetch === 'function' ? await direct(doFetch, url, deps.timeoutMs ?? DIRECT_TIMEOUT_MS) : null;
  if (first !== null && first.status < 500) return first;
  if (fallback === null) return first;
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const second = await within(() => fallback(query, FALLBACK_TIMEOUT_MS), FALLBACK_TIMEOUT_MS);
  return second ?? first;
}
