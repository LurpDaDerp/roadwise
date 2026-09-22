// An in-memory stand-in for the supabase-js client: `from()` runs the same filter chain the
// adapter builds against fixture rows, `rpc()` records every call and answers what the test
// configured, and `storage` is a tripwire: finalize-trip must never touch it.
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface QueryLog {
  table: string;
  select: string | null;
  filters: [op: string, column: string, value: unknown][];
}

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface RpcError {
  code: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

interface QueryResult {
  data: unknown;
  error: null;
  count: number | null;
}

class FakeQuery implements PromiseLike<QueryResult> {
  private readonly filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private single = false;
  private head = false;
  private counting = false;

  constructor(
    private readonly rows: Row[],
    private readonly log: QueryLog,
    private readonly tables: Record<string, Row[]> = {}
  ) {}

  /**
   * A row's own column, or an embedded resource's as PostgREST names it in a filter on an embed
   * (`trips.deleted_at` beside a `trips!inner(…)` select): the parent row through
   * `<embed without its plural s>_id`. A row whose parent is missing is dropped, as `!inner` drops
   * it, so `joined` is false there and every filter fails.
   */
  private cell(row: Row, column: string): { joined: boolean; value: unknown } {
    const dot = column.indexOf('.');
    if (dot === -1) return { joined: true, value: row[column] };
    const table = column.slice(0, dot);
    const parent = (this.tables[table] ?? []).find((p) => p.id === row[`${table.replace(/s$/, '')}_id`]);
    return { joined: parent !== undefined, value: parent?.[column.slice(dot + 1)] };
  }

  select(columns: string, opts?: { count?: string; head?: boolean }): this {
    this.log.select = columns;
    this.head = opts?.head === true;
    this.counting = opts?.count !== undefined;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.log.filters.push(['eq', column, value]);
    this.filters.push((r) => {
      const c = this.cell(r, column);
      return c.joined && c.value === value;
    });
    return this;
  }
  in(column: string, values: readonly unknown[]): this {
    this.log.filters.push(['in', column, values]);
    this.filters.push((r) => {
      const c = this.cell(r, column);
      return c.joined && values.includes(c.value);
    });
    return this;
  }
  is(column: string, value: unknown): this {
    this.log.filters.push(['is', column, value]);
    this.filters.push((r) => {
      const c = this.cell(r, column);
      return c.joined && (value === null ? c.value == null : c.value === value);
    });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.log.filters.push(['gte', column, value]);
    this.filters.push((r) => {
      const c = this.cell(r, column);
      return c.joined && (c.value as string | number) >= (value as string | number);
    });
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private run(): QueryResult {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    const order = this.orderBy;
    if (order) {
      out = [...out].sort((a, b) => {
        const x = a[order.column] as string | number;
        const y = b[order.column] as string | number;
        const c = x < y ? -1 : x > y ? 1 : 0;
        return order.ascending ? c : -c;
      });
    }
    if (this.max !== null) out = out.slice(0, this.max);
    if (this.head) return { data: null, error: null, count: out.length };
    if (this.single) return { data: out[0] ?? null, error: null, count: null };
    return { data: out, error: null, count: this.counting ? out.length : null };
  }

  then<R1 = QueryResult, R2 = never>(
    onfulfilled?: ((value: QueryResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

export interface FakeSupabase {
  client: SupabaseClient;
  queries: QueryLog[];
  rpcCalls: RpcCall[];
  storageTouched: () => boolean;
}

export function fakeSupabase(
  opts: {
    tables?: Record<string, Row[]>;
    rpc?: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: RpcError | null };
  } = {}
): FakeSupabase {
  const tables = opts.tables ?? {};
  const queries: QueryLog[] = [];
  const rpcCalls: RpcCall[] = [];
  let touched = false;
  const client = {
    from(table: string) {
      const log: QueryLog = { table, select: null, filters: [] };
      queries.push(log);
      return new FakeQuery(tables[table] ?? [], log, tables);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const reply = opts.rpc ? opts.rpc(fn, args) : {};
      // `abortSignal` as the real builder has it, so an adapter that bounds a call can chain it.
      const settled = Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
      return Object.assign(settled, { abortSignal: () => settled });
    },
    get storage(): never {
      touched = true;
      throw new Error('finalize-trip must not touch storage');
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    queries,
    rpcCalls,
    storageTouched: () => touched,
  };
}
