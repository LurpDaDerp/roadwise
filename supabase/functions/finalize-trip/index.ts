// Entry point: wires the handler to the runtime's clients. The anon client verifies the caller's
// token with Auth (the signature and the user's existence); the service client, which never leaves
// this process, reads the user's rows and calls the writers. See handler.ts for the contract.
import { createClient } from '@supabase/supabase-js';
import { createDb } from '../_shared/db.ts';
import { handleFinalizeTrip } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) {
  throw new Error('finalize-trip needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const auth = createClient(url, anonKey, stateless).auth;
const db = createDb(createClient(url, serviceKey, stateless));

const verifyJwt = async (token: string): Promise<string | null> => {
  const { data, error } = await auth.getUser(token);
  return error || !data.user ? null : data.user.id;
};

Deno.serve((req) => handleFinalizeTrip(req, { verifyJwt, db }));
