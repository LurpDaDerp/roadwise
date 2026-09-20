// The trip-actions stand-in for the supabase-js client: `fake_supabase.ts` for queries and rpc,
// plus a storage facade that records `remove()` calls instead of tripping, and one ordered log of
// every rpc and storage call so a test can assert that the trace object goes before the writer.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeSupabase, type QueryLog, type RpcCall, type RpcError } from './fake_supabase.ts';

export interface RecordedCall {
  kind: 'rpc' | 'storage';
  /** The rpc function name, or `<bucket>.remove`. */
  name: string;
  args: unknown;
}

export interface StorageCall {
  bucket: string;
  keys: string[];
}

export interface FakeActionsClient {
  client: SupabaseClient;
  queries: QueryLog[];
  rpcCalls: RpcCall[];
  storageCalls: StorageCall[];
  /** Every rpc and storage call, in the order the adapter made them. */
  calls: RecordedCall[];
}

type Row = Record<string, unknown>;

export function fakeActionsClient(
  opts: {
    tables?: Record<string, Row[]>;
    rpc?: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: RpcError | null };
    /** What `remove()` answers with; null (the default) is a success, keys present or not. */
    storageError?: { message: string } | null;
  } = {}
): FakeActionsClient {
  const base = fakeSupabase({ tables: opts.tables, rpc: opts.rpc });
  const calls: RecordedCall[] = [];
  const storageCalls: StorageCall[] = [];
  const storage = {
    from(bucket: string) {
      return {
        remove(keys: string[]) {
          storageCalls.push({ bucket, keys });
          calls.push({ kind: 'storage', name: `${bucket}.remove`, args: keys });
          return Promise.resolve(
            opts.storageError ? { data: null, error: opts.storageError } : { data: [], error: null }
          );
        },
      };
    },
  };
  const target = base.client as unknown as Record<string, unknown>;
  const client = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'storage') return storage;
      if (prop === 'rpc') {
        return (fn: string, args: Record<string, unknown>) => {
          calls.push({ kind: 'rpc', name: fn, args });
          return (t.rpc as (fn: string, args: Record<string, unknown>) => unknown)(fn, args);
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return {
    client: client as unknown as SupabaseClient,
    queries: base.queries,
    rpcCalls: base.rpcCalls,
    storageCalls,
    calls,
  };
}
