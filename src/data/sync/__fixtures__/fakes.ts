/**
 * Test doubles for the sync runner's and the restore's Supabase seams. The fake records every call
 * and answers from handlers the test supplies, so a suite asserts on *what was sent*.
 */

export interface RecordedInvoke {
  name: string;
  body: unknown;
}

export interface RecordedRpc {
  fn: string;
  args: Record<string, unknown> | undefined;
}

export interface SupabaseReply {
  data: unknown;
  error: unknown;
}

export interface FakeSupabaseOptions {
  /** The signed-in user's id, or null for a signed-out client. */
  uid?: string | null;
  invoke?: (invoke: RecordedInvoke, index: number) => SupabaseReply | Promise<SupabaseReply>;
  rpc?: (call: RecordedRpc, index: number) => SupabaseReply | Promise<SupabaseReply>;
  refresh?: (index: number) => SupabaseReply | Promise<SupabaseReply>;
}

export interface FakeSupabase {
  invokes: RecordedInvoke[];
  rpcs: RecordedRpc[];
  refreshes: number;
  sessions: number;
  setUid(uid: string | null): void;
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: null }>;
    refreshSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: unknown }>;
  };
  functions: { invoke(name: string, options: { body: unknown }): Promise<SupabaseReply> };
  rpc(fn: string, args?: Record<string, unknown>): Promise<SupabaseReply>;
}

const ok = (data: unknown): SupabaseReply => ({ data, error: null });

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  let uid = options.uid === undefined ? 'user-1' : options.uid;
  const fake: FakeSupabase = {
    invokes: [],
    rpcs: [],
    refreshes: 0,
    sessions: 0,
    setUid(next) {
      uid = next;
    },
    auth: {
      async getSession() {
        fake.sessions += 1;
        return { data: { session: uid === null ? null : { user: { id: uid } } }, error: null };
      },
      async refreshSession() {
        const index = fake.refreshes;
        fake.refreshes += 1;
        if (options.refresh) {
          const reply = await options.refresh(index);
          return { data: { session: uid === null ? null : { user: { id: uid } } }, error: reply.error };
        }
        return { data: { session: uid === null ? null : { user: { id: uid } } }, error: null };
      },
    },
    functions: {
      async invoke(name, { body }) {
        const record = { name, body };
        const index = fake.invokes.length;
        fake.invokes.push(record);
        return options.invoke ? options.invoke(record, index) : ok({});
      },
    },
    async rpc(fn, args) {
      const record = { fn, args };
      const index = fake.rpcs.length;
      fake.rpcs.push(record);
      return options.rpc ? options.rpc(record, index) : ok(null);
    },
  };
  return fake;
}

/** A `FunctionsHttpError` as supabase-js builds it: the raw `Response` in `context`. */
export function functionsHttpError(status: number, body: unknown, headers: Record<string, string> = {}): SupabaseReply {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
        json: async () => body,
      },
    },
  };
}

/** A `FunctionsFetchError`: the request never left. */
export const functionsFetchError = (): SupabaseReply => ({
  data: null,
  error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
});

export const invokeOk = (body: unknown): SupabaseReply => ok(body);

export interface FakeAppState {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  set(state: string): void;
}

export function createFakeAppState(initial = 'active'): FakeAppState {
  const listeners = new Set<(state: string) => void>();
  return {
    currentState: initial,
    addEventListener(_type, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    set(state) {
      this.currentState = state;
      for (const l of [...listeners]) l(state);
    },
  };
}
