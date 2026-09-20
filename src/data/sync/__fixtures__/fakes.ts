/**
 * Test doubles for the sync runner's four injected seams, for tests only.
 *
 * The Supabase fake records every call it is given and answers from handlers the test supplies,
 * so a suite asserts on *what the runner sent* (bucket, object key, content type, upsert, the
 * function body) rather than on how it was sent. The error builders below reproduce the exact
 * shapes `@supabase/supabase-js` hands back — `StorageApiError` with a numeric `status`, and
 * `FunctionsHttpError` carrying the `Response` in `context` — so the runner's classification is
 * exercised against the real contract rather than a convenient one.
 */
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
}

export interface FakeSupabase {
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
