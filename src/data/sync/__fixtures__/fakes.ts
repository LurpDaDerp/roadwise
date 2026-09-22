/**
 * Test doubles for the sync runner's four injected seams (and the hydrator's table reads), for
 * tests only.
 *
 * The Supabase fake records every call it is given and answers from handlers the test supplies,
 * so a suite asserts on *what the runner sent* (bucket, object key, content type, upsert, the
 * function body) rather than on how it was sent. The error builders below reproduce the exact
 * shapes `@supabase/supabase-js` hands back — `StorageApiError` with a numeric `status`, and
 * `FunctionsHttpError` carrying the `Response` in `context` — so the runner's classification is
 * exercised against the real contract rather than a convenient one.
 */
import type { HydrateQuery, HydrateResponse, HydrateTable } from '@/data/hydrate/hydrate';
import type { TraceBody } from '@/data/sync/runner';

export interface RecordedUpload {
  bucket: string;
  path: string;
  body: TraceBody;
  options: { contentType?: string; upsert?: boolean };
}

export interface RecordedInvoke {
  name: string;
  body: unknown;
}

export interface SupabaseReply {
  data: unknown;
  error: unknown;
}

export interface FakeSupabaseOptions {
  /** The signed-in user's id, or null for a signed-out client. */
  uid?: string | null;
  upload?: (upload: RecordedUpload, index: number) => SupabaseReply | Promise<SupabaseReply>;
  invoke?: (invoke: RecordedInvoke, index: number) => SupabaseReply | Promise<SupabaseReply>;
  /** What `auth.refreshSession()` does; by default it succeeds and keeps the same uid. */
  refresh?: (index: number) => SupabaseReply | Promise<SupabaseReply>;
  /** Rows the PostgREST emulator serves, per table, as the server would render them. */
  tables?: Partial<Record<HydrateTable, Record<string, unknown>[]>>;
  /**
   * Called before a select is answered: may return an error to answer with, and may await (a
   * test pausing a request mid-run, or changing the session while it is in flight).
   */
  onSelect?: (select: RecordedSelect, index: number) => unknown;
}

/** One PostgREST read, as the emulator saw it: table, columns and every filter call in order. */
export interface RecordedSelect {
  table: HydrateTable;
  columns: string;
  /** `eq user_id user-1`, `in trip_id a,b`, `or <filters>`, `order updated_at asc`, `limit 3`. */
  calls: string[];
}

export interface FakeSupabase {
  selects: RecordedSelect[];
  /** Replace or add rows in the emulator's tables between runs. */
  tables: Partial<Record<HydrateTable, Record<string, unknown>[]>>;
  from(table: HydrateTable): { select(columns: string): HydrateQuery };
  uploads: RecordedUpload[];
  invokes: RecordedInvoke[];
  refreshes: number;
  sessions: number;
  /** Change the signed-in user (or sign out) between calls. */
  setUid(uid: string | null): void;
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: null }>;
    refreshSession(): Promise<{
      data: { session: { user: { id: string } } | null };
      error: unknown;
    }>;
  };
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: TraceBody,
        options: { contentType?: string; upsert?: boolean }
      ): Promise<SupabaseReply>;
    };
  };
  functions: {
    invoke(name: string, options: { body: unknown }): Promise<SupabaseReply>;
  };
}

const ok = (data: unknown): SupabaseReply => ({ data, error: null });

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  let uid = options.uid === undefined ? 'user-1' : options.uid;
  const fake: FakeSupabase = {
    selects: [],
    tables: options.tables ?? {},
    from(table: HydrateTable) {
      return {
        select(columns: string) {
          const record: RecordedSelect = { table, columns, calls: [] };
          return emulatedQuery(record, () => fake.tables[table] ?? [], async () => {
            const index = fake.selects.length;
            fake.selects.push(record);
            return options.onSelect ? await options.onSelect(record, index) : null;
          });
        },
      };
    },
    uploads: [],
    invokes: [],
    refreshes: 0,
    sessions: 0,
    setUid(next: string | null) {
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
        if (options.refresh) return options.refresh(index) as never;
        return { data: { session: uid === null ? null : { user: { id: uid } } }, error: null };
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(
            path: string,
            body: TraceBody,
            uploadOptions: { contentType?: string; upsert?: boolean }
          ) {
            const record: RecordedUpload = { bucket, path, body, options: uploadOptions };
            const index = fake.uploads.length;
            fake.uploads.push(record);
            return options.upload
              ? options.upload(record, index)
              : ok({ id: 'o1', path, fullPath: `${bucket}/${path}` });
          },
        };
      },
    },
    functions: {
      async invoke(name: string, invokeOptions: { body: unknown }) {
        const record: RecordedInvoke = { name, body: invokeOptions.body };
        const index = fake.invokes.length;
        fake.invokes.push(record);
        return options.invoke ? options.invoke(record, index) : ok(null);
      },
    },
  };
  return fake;
}

/** What `storage.upload` returns for a non-2xx: a `StorageApiError` with the numeric status. */
export const storageError = (status: number, message: string): SupabaseReply => ({
  data: null,
  error: { name: 'StorageApiError', message, status, statusCode: String(status) },
});

/** What `storage.upload` returns when the object is already there (`upsert: false`). */
export const storageDuplicate = (): SupabaseReply =>
  storageError(409, 'The resource already exists');

/** What `functions.invoke` returns for a non-2xx: a `FunctionsHttpError` holding the Response. */
export function functionsHttpError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): SupabaseReply {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    data: null,
    error: {
      name: 'FunctionsHttpError',
      message: 'Edge Function returned a non-2xx status code',
      context: {
        status,
        headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      },
    },
  };
}

/** What `functions.invoke` returns when the request never reached the server. */
export const functionsFetchError = (): SupabaseReply => ({
  data: null,
  error: {
    name: 'FunctionsFetchError',
    message: 'Failed to send a request to the Edge Function',
  },
});

export const invokeOk = (body: unknown): SupabaseReply => ok(body);

export interface FakeFs {
  files: Map<string, Uint8Array>;
  reads: string[];
  removals: string[];
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<TraceBody>;
  remove(path: string): Promise<void>;
  list(): Promise<string[]>;
}

export function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)])
  );
  return {
    files,
    reads: [],
    removals: [],
    async exists(path: string) {
      return files.has(path);
    },
    async read(path: string) {
      this.reads.push(path);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`no trace file at ${path}`);
      return bytes;
    },
    async remove(path: string) {
      this.removals.push(path);
      files.delete(path);
    },
    async list() {
      return [...files.keys()];
    },
  };
}

export interface FakeAppState {
  listeners: ((state: string) => void)[];
  removals: number;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  /** Drive a foreground/background transition from a test. */
  emit(state: string): void;
}

export function createFakeAppState(): FakeAppState {
  const fake: FakeAppState = {
    listeners: [],
    removals: 0,
    addEventListener(_type: 'change', listener: (state: string) => void) {
      fake.listeners.push(listener);
      return {
        remove() {
          fake.removals += 1;
          fake.listeners = fake.listeners.filter((l) => l !== listener);
        },
      };
    },
    emit(state: string) {
      for (const listener of [...fake.listeners]) listener(state);
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------------
// A PostgREST emulator: enough of the filter builder for the hydrator's reads, evaluated over
// in-memory rows the way the server would. Comparison is on the rendered strings — ISO
// timestamps in one format and lowercase uuids both order correctly as text.
// ---------------------------------------------------------------------------------------------

type Predicate = (row: Record<string, unknown>) => boolean;

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** Split on commas that are not inside parentheses. */
function splitTop(filters: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < filters.length; i += 1) {
    const c = filters[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(filters.slice(start, i));
      start = i + 1;
    }
  }
  out.push(filters.slice(start));
  return out;
}

/** One term of an `or(...)`/`and(...)` filter: `col.op.value` or a nested group. */
function parseTerm(term: string): Predicate {
  if (term.startsWith('and(') && term.endsWith(')')) {
    const parts = splitTop(term.slice(4, -1)).map(parseTerm);
    return (row) => parts.every((p) => p(row));
  }
  if (term.startsWith('or(') && term.endsWith(')')) {
    const parts = splitTop(term.slice(3, -1)).map(parseTerm);
    return (row) => parts.some((p) => p(row));
  }
  const first = term.indexOf('.');
  const second = term.indexOf('.', first + 1);
  if (first < 0 || second < 0) throw new Error(`emulator: cannot parse filter term ${term}`);
  const column = term.slice(0, first);
  const op = term.slice(first + 1, second);
  const value = term.slice(second + 1);
  switch (op) {
    case 'eq':
      return (row) => text(row[column]) === value;
    case 'gt':
      return (row) => text(row[column]) > value;
    case 'gte':
      return (row) => text(row[column]) >= value;
    default:
      throw new Error(`emulator: unsupported operator ${op}`);
  }
}

function emulatedQuery(
  record: RecordedSelect,
  rows: () => Record<string, unknown>[],
  before: () => Promise<unknown>
): HydrateQuery {
  const predicates: Predicate[] = [];
  const orderBy: { column: string; ascending: boolean }[] = [];
  let limit: number | null = null;

  const run = async (): Promise<HydrateResponse> => {
    const error = await before();
    if (error !== null && error !== undefined) return { data: null, error };
    let out = rows().filter((row) => predicates.every((p) => p(row)));
    out = [...out].sort((a, b) => {
      for (const { column, ascending } of orderBy) {
        const x = text(a[column]);
        const y = text(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    if (limit !== null) out = out.slice(0, limit);
    // A copy per row, as a network response would be.
    return { data: out.map((row) => JSON.parse(JSON.stringify(row)) as unknown), error: null };
  };

  const query: HydrateQuery = {
    eq(column, value) {
      record.calls.push(`eq ${column} ${value}`);
      predicates.push((row) => text(row[column]) === value);
      return query;
    },
    is(column, value) {
      record.calls.push(`is ${column} ${String(value)}`);
      predicates.push((row) => row[column] === null || row[column] === undefined);
      return query;
    },
    in(column, values) {
      record.calls.push(`in ${column} ${values.join(',')}`);
      const set = new Set(values);
      predicates.push((row) => set.has(text(row[column])));
      return query;
    },
    or(filters) {
      record.calls.push(`or ${filters}`);
      const parts = splitTop(filters).map(parseTerm);
      predicates.push((row) => parts.some((p) => p(row)));
      return query;
    },
    gt(column, value) {
      record.calls.push(`gt ${column} ${value}`);
      predicates.push((row) => text(row[column]) > value);
      return query;
    },
    gte(column, value) {
      record.calls.push(`gte ${column} ${value}`);
      predicates.push((row) => text(row[column]) >= value);
      return query;
    },
    order(column, options) {
      const ascending = options?.ascending ?? true;
      record.calls.push(`order ${column} ${ascending ? 'asc' : 'desc'}`);
      orderBy.push({ column, ascending });
      return query;
    },
    limit(count) {
      record.calls.push(`limit ${count}`);
      limit = count;
      return query;
    },
    then(onFulfilled, onRejected) {
      return run().then(onFulfilled, onRejected);
    },
  };
  return query;
}
