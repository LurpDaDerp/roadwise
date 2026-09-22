/**
 * A recording stand-in for the slice of `@supabase/supabase-js` the devices module uses: `from()`
 * chains (upsert, update, insert, select, eq, abortSignal), `rpc()` and `auth.getSession()`.
 *
 * Every chain is one `Call`, settled when it is awaited, by `respond` (default: success, with one
 * row for a `select`). A test swaps `respond` to fail, hang or return nothing.
 */
import type { DevicesClient } from '../register';

export interface Call {
  kind: 'from' | 'rpc';
  /** The table for `from`, the function for `rpc`. */
  target: string;
  op: 'select' | 'upsert' | 'update' | 'insert' | 'rpc' | null;
  values?: unknown;
  options?: unknown;
  columns?: string;
  filters: [string, unknown][];
  signal?: AbortSignal;
}

export type Result = { data: unknown; error: unknown };
export type Respond = (call: Call) => Result | Promise<Result>;

export const ok: Respond = (call) =>
  call.columns !== undefined ? { data: [{ id: 'row' }], error: null } : { data: null, error: null };

export interface FakeSupabase {
  client: DevicesClient;
  calls: Call[];
  respond: Respond;
  sessionUid: string | null;
  /** The calls that wrote to `target` (a table or an RPC). */
  to(target: string): Call[];
}

export function createFakeSupabase(sessionUid: string | null = 'user-a'): FakeSupabase {
  const fake: FakeSupabase = {
    calls: [],
    respond: ok,
    sessionUid,
    to: (target) => fake.calls.filter((c) => c.target === target),
    client: undefined as unknown as DevicesClient,
  };

  function builder(call: Call) {
    let settled: Promise<Result> | null = null;
    const b = {
      select(columns = '*') {
        call.columns = columns;
        if (call.op === null) call.op = 'select';
        return b;
      },
      upsert(values: unknown, options?: unknown) {
        call.op = 'upsert';
        call.values = values;
        call.options = options;
        return b;
      },
      update(values: unknown) {
        call.op = 'update';
        call.values = values;
        return b;
      },
      insert(values: unknown) {
        call.op = 'insert';
        call.values = values;
        return b;
      },
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return b;
      },
      abortSignal(signal: AbortSignal) {
        call.signal = signal;
        return b;
      },
      then<T1 = Result, T2 = never>(
        onFulfilled?: ((r: Result) => T1 | PromiseLike<T1>) | null,
        onRejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null
      ): Promise<T1 | T2> {
        if (!settled) {
          fake.calls.push(call);
          settled = Promise.resolve().then(() => fake.respond(call));
        }
        return settled.then(onFulfilled, onRejected);
      },
    };
    return b;
  }

  fake.client = {
    from: (table: string) => builder({ kind: 'from', target: table, op: null, filters: [] }),
    rpc: (fn: string, args: unknown) =>
      builder({ kind: 'rpc', target: fn, op: 'rpc', values: args, filters: [] }),
    auth: {
      getSession: async () => ({
        data: { session: fake.sessionUid === null ? null : { user: { id: fake.sessionUid } } },
        error: null,
      }),
    },
  } as unknown as DevicesClient;

  return fake;
}

/** An in-memory settings store with the repo's shape. */
export function createMemorySettings(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: async <T>(key: string): Promise<T | null> =>
      values.has(key) ? (JSON.parse(JSON.stringify(values.get(key))) as T) : null,
    getOr: async <T>(key: string, fallback: T): Promise<T> =>
      values.has(key) ? (values.get(key) as T) : fallback,
    set: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    remove: async (key: string): Promise<boolean> => values.delete(key),
    all: async () => Object.fromEntries(values),
  };
}
