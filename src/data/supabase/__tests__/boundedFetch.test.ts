// No Supabase request may wait forever for an answer: Android's OkHttp has no time-out of its own,
// and one silent request held the sync runner, Sign out and an account handover for the life of the
// process. Every request is bounded, and one that runs out fails as the network failing.
import { isAuthRetryableFetchError } from '@supabase/auth-js';
import { createClient } from '@supabase/supabase-js';

import { boundedFetch, requestTimedOut, SUPABASE_REQUEST_BOUND_MS } from '@/data/supabase/boundedFetch';
import { classifyInvokeError, classifyRpcError } from '@/data/sync/response';
import { createPumpedTimers } from '@/lib/timers';

type Seen = { input: unknown; init: RequestInit | undefined };

/** A fetch that answers only when told to, and fails when its signal aborts, as Expo's does. */
function heldFetch() {
  const seen: Seen[] = [];
  let answer: (r: Response) => void = () => {};
  const base = jest.fn(
    (input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        seen.push({ input, init });
        answer = resolve;
        if (init?.signal?.aborted) reject(new Error('fetch failed: canceled'));
        init?.signal?.addEventListener('abort', () => reject(new Error('fetch failed: canceled')));
      })
  );
  return { base: base as unknown as typeof fetch, seen, answer: (r: Response) => answer(r) };
}

/** A response whose body arrives only when told to, and fails when `signal` aborts. */
function slowBody(signal: AbortSignal | null | undefined) {
  let deliver: (text: string) => void = () => {};
  const body = new Promise<string>((resolve, reject) => {
    deliver = resolve;
    signal?.addEventListener('abort', () => reject(new Error('fetch failed: canceled')));
  });
  const response = { ok: true, status: 200, text: () => body, json: async () => JSON.parse(await body) as unknown };
  return { response: response as unknown as Response, deliver: (text: string) => deliver(text) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('the bound is 5 minutes: longer than iOS’s own 60 s, and than any request that still moves', () => {
  expect(SUPABASE_REQUEST_BOUND_MS).toBe(300_000);
  expect(SUPABASE_REQUEST_BOUND_MS).toBeGreaterThan(150_000);
});

test('a request that answers passes through with its own init, and its bound is gone once the body is read', async () => {
  const timers = createPumpedTimers();
  const held = heldFetch();
  const doFetch = boundedFetch(held.base, 1_000, timers);
  const pending = doFetch('https://x.supabase.co/rest/v1/rpc/f', { method: 'POST', body: '{}', headers: { a: 'b' } });
  await tick();
  expect(held.seen[0]?.init).toMatchObject({ method: 'POST', body: '{}', headers: { a: 'b' } });
  expect(held.seen[0]?.init?.signal).toBeDefined();
  expect(timers.pending()).toBe(1);
  held.answer(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const response = await pending;
  // Still bounded while the body is out.
  expect(timers.pending()).toBe(1);
  expect(await response.json()).toEqual({ ok: true });
  expect(timers.pending()).toBe(0);
});

test('a request that never answers is aborted at the bound and fails as an abort', async () => {
  const held = heldFetch();
  const doFetch = boundedFetch(held.base, 20, createPumpedTimers());
  const failure = await doFetch('https://x.supabase.co/functions/v1/finalize-trip').catch((e: unknown) => e);
  expect(held.seen[0]?.init?.signal?.aborted).toBe(true);
  expect(failure).toMatchObject({ name: 'AbortError', message: requestTimedOut(20).message });
});

test('a body that stops arriving is aborted at the bound too', async () => {
  const timers = createPumpedTimers();
  const held = heldFetch();
  const doFetch = boundedFetch(held.base, 20, timers);
  const pending = doFetch('https://x.supabase.co/rest/v1/rpc/f');
  await tick();
  const slow = slowBody(held.seen[0]?.init?.signal);
  held.answer(slow.response);
  const response = await pending;
  await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
  expect(timers.pending()).toBe(0);
});

test('it is one of the pumped timers: with the JS timer paused (Android, RoadWise behind) the next pump past the bound fires it', async () => {
  let now = 0;
  const timers = createPumpedTimers({ now: () => now, setTimeout: () => 0, clearTimeout: () => {} });
  const held = heldFetch();
  const pending = boundedFetch(held.base, 1_000, timers)('https://x.supabase.co/auth/v1/token').catch((e: unknown) => e);
  await tick();
  now = 999;
  timers.pump();
  expect(held.seen[0]?.init?.signal?.aborted).toBe(false);
  now = 1_000;
  timers.pump();
  expect(await pending).toMatchObject({ name: 'AbortError' });
});

test('the caller’s own signal still aborts the request, with the fetch’s own failure', async () => {
  const timers = createPumpedTimers();
  const held = heldFetch();
  const caller = new AbortController();
  const pending = boundedFetch(held.base, 60_000, timers)('https://x', { signal: caller.signal }).catch((e: unknown) => e);
  await tick();
  caller.abort();
  const failure = await pending;
  expect(held.seen[0]?.init?.signal?.aborted).toBe(true);
  expect(failure).toMatchObject({ message: 'fetch failed: canceled' });
  expect(timers.pending()).toBe(0);
});

test('a response nobody reads lets go of the caller’s signal once its bound has run out', async () => {
  let now = 0;
  const timers = createPumpedTimers({ now: () => now, setTimeout: () => 0, clearTimeout: () => {} });
  const held = heldFetch();
  const caller = new AbortController();
  const removed = jest.spyOn(caller.signal, 'removeEventListener');
  const pending = boundedFetch(held.base, 1_000, timers)('https://x.supabase.co/auth/v1/logout', { signal: caller.signal });
  await tick();
  held.answer(new Response(null, { status: 204 }));
  await pending;
  expect(removed).not.toHaveBeenCalled();
  now = 1_000;
  timers.pump();
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(timers.pending()).toBe(0);
});

test('a caller signal already aborted aborts at once', async () => {
  const held = heldFetch();
  const caller = new AbortController();
  caller.abort();
  const failure = await boundedFetch(held.base, 60_000, createPumpedTimers())('https://x', { signal: caller.signal }).catch((e: unknown) => e);
  expect(held.seen[0]?.init?.signal?.aborted).toBe(true);
  expect(failure).toMatchObject({ message: 'fetch failed: canceled' });
});

describe('through the Supabase client, a request that runs out is the network failing, as every caller reads it', () => {
  const hang = (() => heldFetch().base)();
  const client = () =>
    createClient('https://example.supabase.co', 'sb_publishable_test', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch(hang, 20, createPumpedTimers()) },
    });

  test('an edge function (the runner’s uploads): a retryable network failure', async () => {
    const { error } = await client().functions.invoke('finalize-trip', { body: { a: 1 } });
    expect(await classifyInvokeError(error, Date.now())).toEqual({ kind: 'retryable', code: 'network', status: null, retryAfterS: null });
  });

  test('an RPC (the runner’s actions, the restore): a retryable network failure', async () => {
    const { error } = await client().rpc('record_passenger_ride', {});
    expect(classifyRpcError(error)).toEqual({ kind: 'retryable', code: 'network', status: null, retryAfterS: null });
  });

  test('an auth request (the token refresh goes the same way): auth-js’s retryable fetch error, which keeps a stored session', async () => {
    const { error } = await client().auth.signInWithPassword({ email: 'ava@example.com', password: 'x' });
    expect(isAuthRetryableFetchError(error)).toBe(true);
  });
});
