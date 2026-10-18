// The caller's identity: the user id GoTrue confirms for the bearer token, and nothing else. Every
// function derives "whose data" from this alone; a body never names a user.
import { createClient } from '@supabase/supabase-js';

export type VerifyJwt = (token: string) => Promise<string | null>;

/**
 * A token Auth refuses is null (401). A failure to reach Auth at all (auth-js hands those back as
 * a retryable fetch error rather than throwing) is thrown, so the handler answers 503 and the
 * device retries instead of discarding a session that may be fine.
 */
export function createVerifyJwt(url: string, publishableKey: string): VerifyJwt {
  const auth = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }).auth;
  return async (token) => {
    const { data, error } = await auth.getUser(token);
    if (error) {
      if (error.name === 'AuthRetryableFetchError') throw error;
      return null;
    }
    return data.user ? data.user.id : null;
  };
}

/** The runtime's connection string for the direct engine connection, or a clear error. */
export function requireEnv(name: string, fn: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${fn} needs ${name}`);
  return v;
}

/**
 * The project's `default` API key of one kind (sb_publishable_… / sb_secret_…). The hosted runtime
 * injects every key by name as JSON in SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS; the local
 * stack sets the single SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY. The legacy
 * SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY JWTs are never read.
 */
export function requireApiKey(kind: 'publishable' | 'secret', fn: string): string {
  const name = kind === 'publishable' ? 'SUPABASE_PUBLISHABLE_KEY' : 'SUPABASE_SECRET_KEY';
  const named = Deno.env.get(`${name}S`);
  if (named) {
    let key: unknown;
    try {
      key = (JSON.parse(named) as Record<string, unknown>)['default'];
    } catch {
      throw new Error(`${fn} could not parse ${name}S`);
    }
    if (typeof key === 'string' && key) return key;
  }
  return requireEnv(name, fn);
}
