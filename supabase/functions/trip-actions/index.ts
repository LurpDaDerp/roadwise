// Entry point: wires the handler to the runtime's clients. The anon client verifies the caller's
// token with Auth (the signature and the user's existence); the service client, which never leaves
// this process, reads the user's rows, removes trace objects and calls the writers. See handler.ts
// for the contract.
import { createClient } from '@supabase/supabase-js';
import { createActionsDb } from '../_shared/actions_db.ts';
import { handleTripAction } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) {
  throw new Error('trip-actions needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const auth = createClient(url, anonKey, stateless).auth;
const db = createActionsDb(createClient(url, serviceKey, stateless));

// A token Auth refuses is null (401). A failure to reach Auth at all (auth-js hands those back as
// a retryable fetch error rather than throwing) is thrown, so the handler answers 503 and the
// queue retries instead of discarding a session that may be fine.
const verifyJwt = async (token: string): Promise<string | null> => {
  const { data, error } = await auth.getUser(token);
  if (error) {
    if (error.name === 'AuthRetryableFetchError') throw error;
    return null;
  }
  return data.user ? data.user.id : null;
};

Deno.serve((req) => handleTripAction(req, { verifyJwt, db }));
