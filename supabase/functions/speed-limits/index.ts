// Entry point: wires the handler to the runtime's clients. The anon client verifies the caller's
// token with Auth (the signature and the user's existence); the service client, which never leaves
// this process, calls the speed-limit functions (service-role only). The AWS client exists only
// when all three AWS secrets are set; without them the function answers from open data and the
// cache, and says `fallback: null`. See handler.ts for the contract.
import { createClient } from '@supabase/supabase-js';
import { createAwsRoutesClient } from './aws.ts';
import { createSpeedLimitsDb, handleSpeedLimits } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) {
  throw new Error('speed-limits needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const auth = createClient(url, anonKey, stateless).auth;
const db = createSpeedLimitsDb(createClient(url, serviceKey, stateless));
const routes = createAwsRoutesClient(Deno.env);

// A token Auth refuses is null (401). A failure to reach Auth at all is thrown, so the handler
// answers 503 and the device retries rather than treating a fine session as signed out.
const verifyJwt = async (token: string): Promise<string | null> => {
  const { data, error } = await auth.getUser(token);
  if (error) {
    if (error.name === 'AuthRetryableFetchError') throw error;
    return null;
  }
  return data.user ? data.user.id : null;
};

Deno.serve((req) => handleSpeedLimits(req, { verifyJwt, db, routes }));
