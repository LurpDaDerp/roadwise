// Entry point: wires the handler to the runtime's clients. The anon client verifies the caller's
// token with Auth; the service client, which never leaves this process, lists and removes the
// caller's objects and deletes the auth user. See handler.ts for the contract.
import { createClient } from '@supabase/supabase-js';
import { createDeletePorts, handleAccountDelete } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) {
  throw new Error('account-delete needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const auth = createClient(url, anonKey, stateless).auth;
const ports = createDeletePorts(createClient(url, serviceKey, stateless));

// A token Auth refuses is null (401): after a delete that already happened, that is what a retry
// gets. A failure to reach Auth at all is thrown, so the handler answers 503.
const verifyJwt = async (token: string): Promise<string | null> => {
  const { data, error } = await auth.getUser(token);
  if (error) {
    if (error.name === 'AuthRetryableFetchError') throw error;
    return null;
  }
  return data.user ? data.user.id : null;
};

Deno.serve((req) => handleAccountDelete(req, { verifyJwt, ports }));
