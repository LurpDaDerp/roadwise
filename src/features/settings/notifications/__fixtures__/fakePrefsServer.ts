/**
 * A stand-in for the `notification_prefs` table as 0007 grants it: select, insert and update
 * chains, row-level to one user. It refuses what Postgres would: an upsert (a `DO UPDATE SET
 * user_id` has no UPDATE grant → 42501), an update naming `user_id` (42501), a column outside the
 * grants (42501), a second insert for the same user (23505). Every chain is logged.
 */
import type { PrefsClient } from '../api';

export interface PrefsCall {
  op: 'select' | 'insert' | 'update' | 'upsert';
  values?: Record<string, unknown>;
  filters: [string, unknown][];
  columns?: string;
}

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: unknown; status: number };

const INSERTABLE = new Set([
  'user_id',
  'categories',
  'quiet_enabled',
  'quiet_start',
  'quiet_end',
  'tz',
  'local_sent_day',
  'local_sent_count',
]);
const UPDATABLE = new Set([...INSERTABLE].filter((c) => c !== 'user_id'));

const denied = (message: string): Reply => ({ data: null, error: { code: '42501', message }, status: 403 });

export function createFakePrefsServer(initial: Row[] = []) {
  const server = {
    rows: [] as Row[],
    calls: [] as PrefsCall[],
    /** When set, the next call of that op replies with this error instead (then clears). */
    fail: {} as Partial<Record<PrefsCall['op'], unknown>>,
    /** Every call fails as a transport error (status 0). */
    offline: false,
    /** Runs just before an insert is applied (a concurrent writer, in a test). */
    beforeInsert: null as null | (() => void),
    client: undefined as unknown as PrefsClient,
    writes: () => server.calls.filter((c) => c.op !== 'select'),
  };

  const full = (row: Row): Row => ({
    categories: {},
    quiet_enabled: null,
    quiet_start: null,
    quiet_end: null,
    tz: null,
    local_sent_day: null,
    local_sent_count: 0,
    ...row,
  });

  server.rows = initial.map(full);

  function run(call: PrefsCall): Reply {
    if (server.offline) return { data: null, error: { message: 'Network request failed' }, status: 0 };
    const injected = server.fail[call.op];
    if (injected !== undefined) {
      delete server.fail[call.op];
      return { data: null, error: injected, status: 500 };
    }
    const uid = call.filters.find(([c]) => c === 'user_id')?.[1];
    switch (call.op) {
      case 'upsert':
        return denied('permission denied for table notification_prefs (upsert sets user_id)');
      case 'select':
        return { data: server.rows.filter((r) => r.user_id === uid).map(full), error: null, status: 200 };
      case 'update': {
        for (const k of Object.keys(call.values ?? {})) {
          if (!UPDATABLE.has(k)) return denied(`permission denied for column ${k}`);
        }
        const hit = server.rows.filter((r) => r.user_id === uid);
        for (const r of hit) Object.assign(r, call.values);
        return { data: hit.map(full), error: null, status: 200 };
      }
      case 'insert': {
        const values = call.values ?? {};
        for (const k of Object.keys(values)) {
          if (!INSERTABLE.has(k)) return denied(`permission denied for column ${k}`);
        }
        server.beforeInsert?.();
        server.beforeInsert = null;
        if (server.rows.some((r) => r.user_id === values.user_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 };
        }
        const row = full(values);
        server.rows.push(row);
        return { data: [row], error: null, status: 201 };
      }
    }
  }

  function builder(call: PrefsCall) {
    let settled: Promise<Reply> | null = null;
    const b = {
      select(columns = '*') {
        call.columns = columns;
        return b;
      },
      update(values: Row) {
        call.op = 'update';
        call.values = values;
        return b;
      },
      insert(values: Row) {
        call.op = 'insert';
        call.values = values;
        return b;
      },
      upsert(values: Row) {
        call.op = 'upsert';
        call.values = values;
        return b;
      },
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return b;
      },
      limit() {
        return b;
      },
      then<T1 = Reply, T2 = never>(
        onFulfilled?: ((r: Reply) => T1 | PromiseLike<T1>) | null,
        onRejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null
      ): Promise<T1 | T2> {
        if (!settled) {
          server.calls.push(call);
          settled = Promise.resolve().then(() => run(call));
        }
        return settled.then(onFulfilled, onRejected);
      },
    };
    return b;
  }

  server.client = {
    from: (table: string) => {
      if (table !== 'notification_prefs') throw new Error(`unexpected table ${table}`);
      return builder({ op: 'select', filters: [] });
    },
  } as unknown as PrefsClient;

  return server;
}

export type FakePrefsServer = ReturnType<typeof createFakePrefsServer>;
