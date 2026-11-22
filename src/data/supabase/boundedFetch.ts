/**
 * The app's Supabase client sends every request through this fetch (`client.ts`), so no request
 * can wait forever for an answer.
 *
 * - On Android nothing below JS ever ends a request that stops answering: the global fetch is
 *   Expo's, whose OkHttp client sets no connect, read or write time-out. A request whose connection
 *   goes silent after it was sent (a garage, a tunnel, a frozen process) never settles, and the
 *   sync runner, Sign out and an account handover wait on it for the life of the process. iOS ends
 *   such a request after 60 s without data (URLSession's own default); this does the same job on
 *   both, once, for everything the client sends: the uploads, the RPCs, the token refresh.
 * - The bound is the whole exchange, from the request to its body read: 5 minutes. A request that
 *   still moves is never that slow: a long drive's finalize-trip upload is at most 512 KB (about
 *   2 minutes on a 40 kbps link), Supabase itself ends a function that has not answered after
 *   150 s, and an account export is one JSON file. So it only ever ends a request that has stopped,
 *   and on iOS it comes after URLSession's own 60 s, which fires first on a silent connection.
 * - A request that runs out is aborted (Expo cancels the native request) and rejects as an
 *   `AbortError`, which every caller already reads as the network failing: the runner's retryable
 *   `network`, auth-js's retryable fetch error (the stored session is kept), PostgREST's status 0.
 *   PostgREST does not repeat an aborted request.
 * - The caller's own signal still works (the speed-limit, weather and Live Activity time-outs are
 *   shorter and win), and the bound is one of the process's pumped timers (`@/lib/timers`):
 *   Android pauses plain JS timers while RoadWise is behind, and a drive's rows then fire it.
 */
import { processTimers, type Timers } from '@/lib/timers';

/** The longest any one request may take, from the request to its body read. */
export const SUPABASE_REQUEST_BOUND_MS = 5 * 60_000;

type Fetch = typeof fetch;

/** The body readers a response is read through; the bound ends when one of them settles. */
const READERS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;

/** What a request that ran out rejects with: an abort, as every caller already reads one. */
export function requestTimedOut(boundMs: number): Error {
  const error = new Error(`The request did not finish within ${boundMs} ms`);
  error.name = 'AbortError';
  return error;
}

/**
 * `base` (the global fetch, read at call time so Expo's installed one is used) with every request
 * bounded by `boundMs` and aborted when the caller's own signal aborts.
 */
export function boundedFetch(
  base: Fetch = (input, init) => globalThis.fetch(input, init),
  boundMs: number = SUPABASE_REQUEST_BOUND_MS,
  timers: Timers = processTimers
): Fetch {
  return async (input, init) => {
    const control = new AbortController();
    // Never throws into a timer or a pump (the drive host pumps these timers on every row).
    const abort = (): void => {
      try {
        control.abort();
      } catch {
        // The request is being given up either way.
      }
    };
    const caller = init?.signal ?? null;
    if (caller?.aborted) abort();
    else caller?.addEventListener('abort', abort);

    let released = false;
    let timedOut = false;
    const timer = timers.setTimeout(() => {
      timedOut = true;
      abort();
      // A response nobody reads (auth-js's logout, an error answer left unread) never settles a
      // reader: the caller's listener goes here instead.
      release();
    }, boundMs);
    const release = (): void => {
      if (released) return;
      released = true;
      timers.clearTimeout(timer);
      caller?.removeEventListener('abort', abort);
    };
    const failure = (error: unknown): unknown => (timedOut ? requestTimedOut(boundMs) : error);

    let response: Response;
    try {
      response = await base(input, { ...init, signal: control.signal });
    } catch (error) {
      release();
      throw failure(error);
    }

    // The bound ends once the body has been read, or has failed to be. Done on the response
    // itself, so every way it is read counts. One that cannot be wrapped keeps its bound to the
    // end, whose abort then finds the request finished and changes nothing.
    const target = response as unknown as Record<string, unknown>;
    try {
      for (const name of READERS) {
        const read = target[name];
        if (typeof read !== 'function') continue;
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]): Promise<unknown> =>
            Promise.resolve((read as (...a: unknown[]) => Promise<unknown>).apply(response, args)).then(
              (value) => {
                release();
                return value;
              },
              (error: unknown) => {
                release();
                throw failure(error);
              }
            ),
        });
      }
    } catch {
      // Left as it was: see above.
    }
    return response;
  };
}
