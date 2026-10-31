import { Observe } from 'expo-observe';

import {
  createCrashSink,
  loadObserve,
  MAX_REPORTS_PER_LAUNCH,
  REPORT_REPEAT_MS,
  reportError,
  scrub,
  scrubbedCopy,
  scrubGlobalErrors,
  withCrashReporting,
  type CrashApi,
  type GlobalErrorUtils,
} from '../crashReport';

function harness(opts: { enabled?: boolean; api?: CrashApi | null } = {}) {
  let now = 1_000_000;
  const api = opts.api === undefined ? { reportError: jest.fn() } : opts.api;
  const load = jest.fn(() => api);
  const sink = createCrashSink({ enabled: opts.enabled ?? true, load, now: () => now });
  return {
    sink,
    load,
    api,
    advance: (ms: number) => {
      now += ms;
    },
    sent: (): Error[] => ((api?.reportError as jest.Mock | undefined)?.mock?.calls ?? []).map((c: unknown[]) => c[0] as Error),
  };
}

describe('scrub', () => {
  test('tokens, bearer headers, emails, ids, query strings and coordinates leave the text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(scrub(`bad jwt ${jwt}`)).toBe('bad jwt [token]');
    expect(scrub('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [token]');
    expect(scrub('no user teen.driver+1@example.co.uk here')).toBe('no user [email] here');
    expect(scrub('trip 3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b failed')).toBe('trip [id] failed');
    expect(scrub('GET https://overpass.example/api?data=way(around:30,37.77,-122.41) 504')).toBe(
      'GET https://overpass.example/api?[query] 504'
    );
    expect(scrub('at 37.774929, -122.419416')).toBe('at [n], [n]');
    expect(scrub('push ExponentPushToken 0123456789abcdef0123456789abcdef01')).toBe('push ExponentPushToken [token]');
  });

  test('ordinary messages and stack frames are kept', () => {
    const stack = 'TypeError: undefined is not a function\n    at useSyncExternalStoreWithSelector (index.android.bundle:1:23456)';
    expect(scrub(stack)).toBe(stack);
    expect(scrub('Why? It timed out after 4000 ms (v57.0.26)')).toBe('Why? It timed out after 4000 ms (v57.0.26)');
  });
});

describe('the crash sink', () => {
  test('sends the error with its context, name and stack, scrubbed', () => {
    const h = harness();
    const error = new TypeError('no row for driver@example.com');
    error.stack = 'TypeError: no row for driver@example.com\n    at read (bundle:1:2)';
    h.sink.report(error, 'bootstrap: recover 3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b');
    const sent = h.sent()[0]!;
    expect(sent).toBeInstanceOf(Error);
    expect(sent.name).toBe('TypeError');
    expect(sent.message).toBe('bootstrap: recover [id]: no row for [email]');
    expect(sent.stack).toBe('TypeError: no row for [email]\n    at read (bundle:1:2)');
  });

  test('a value that is not an Error: a string as its message, an object only by its message, anything else by its type', () => {
    const h = harness();
    h.sink.report('plain string', 'a');
    h.sink.report({ message: 'permission denied', details: 'row lat=37.7749', hint: 'x' }, 'b');
    h.sink.report(42, 'c');
    h.sink.report(null, 'd');
    expect(h.sent().map((e) => e.message)).toEqual([
      'a: plain string',
      'b: permission denied',
      'c: non-error value (number)',
      'd: non-error value (null)',
    ]);
    expect(h.sent().every((e) => e.stack === undefined)).toBe(true);
  });

  test('the same context and message go once a minute, however often they fire', () => {
    const h = harness();
    for (let i = 0; i < 60; i += 1) {
      h.sink.report(new Error('no fix'), 'drive gps');
      h.advance(1000);
    }
    expect(h.sent()).toHaveLength(1);
    h.advance(REPORT_REPEAT_MS);
    h.sink.report(new Error('no fix'), 'drive gps');
    expect(h.sent()).toHaveLength(2);
    // A different context or message is its own report.
    h.sink.report(new Error('no fix'), 'drive heading');
    h.sink.report(new Error('lost fix'), 'drive gps');
    expect(h.sent()).toHaveLength(4);
  });

  test(`a launch sends at most ${MAX_REPORTS_PER_LAUNCH} reports`, () => {
    const h = harness();
    for (let i = 0; i < MAX_REPORTS_PER_LAUNCH + 20; i += 1) h.sink.report(new Error(`failure ${i}`), 'x');
    expect(h.sent()).toHaveLength(MAX_REPORTS_PER_LAUNCH);
  });

  test('off (dev, tests): nothing is loaded or sent', () => {
    const h = harness({ enabled: false });
    h.sink.report(new Error('boom'), 'x');
    expect(h.load).not.toHaveBeenCalled();
    expect(h.sent()).toHaveLength(0);
  });

  test('never throws: no reporting API, a reporter that throws, a value whose fields throw', () => {
    expect(() => harness({ api: null }).sink.report(new Error('boom'), 'x')).not.toThrow();
    const throwing = harness({
      api: {
        reportError: () => {
          throw new Error('native refused');
        },
      },
    });
    expect(() => throwing.sink.report(new Error('boom'), 'x')).not.toThrow();
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
    };
    expect(() => harness().sink.report(hostile, 'x')).not.toThrow();
  });
});

describe('uncaught errors', () => {
  test('the global handler installed before (expo-app-metrics) only ever gets a scrubbed copy', () => {
    const previous = jest.fn();
    let current: Parameters<GlobalErrorUtils['setGlobalHandler']>[0] = previous;
    const utils: GlobalErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (h) => {
        current = h;
      },
    };
    scrubGlobalErrors(utils);
    expect(current).not.toBe(previous);

    const error = new TypeError('no row for driver@example.com at 37.774929');
    error.stack = 'TypeError: no row for driver@example.com\n    at read (bundle:1:2) 3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b';
    current(error, true);
    expect(previous).toHaveBeenCalledTimes(1);
    const [sent, isFatal] = previous.mock.calls[0] as [Error, boolean];
    expect(isFatal).toBe(true);
    expect(sent).not.toBe(error);
    expect(sent.name).toBe('TypeError');
    expect(sent.message).toBe('no row for [email] at [n]');
    expect(sent.stack).toBe('TypeError: no row for [email]\n    at read (bundle:1:2) [id]');
  });

  test('a copy is made of any thrown value, never throwing', () => {
    expect(scrubbedCopy('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl').message).toBe('token [token]');
    expect(scrubbedCopy(null).message).toBe('non-error value (null)');
    expect(scrubbedCopy({ message: 'x'.repeat(600), details: 'secret' }).message).toHaveLength(501);
  });
});

describe('the app sink under Jest', () => {
  test('is off: Observe is never loaded, configured or called, and the root is left unwrapped', () => {
    expect(loadObserve()).toBeNull();
    reportError(new Error('boom'), 'root screen');
    expect(Observe.configure).not.toHaveBeenCalled();
    expect(Observe.reportError).not.toHaveBeenCalled();
    const Root = () => null;
    expect(withCrashReporting(Root)).toBe(Root);
  });
});
