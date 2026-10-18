// Entry point: wires the handler to the runtime's clients. The publishable-key client verifies the
// caller's token with Auth (the signature and the user's existence); the secret-key client, which
// never leaves this process, calls the speed-limit functions (service-role only). The AWS client
// exists only when all three AWS secrets are set; without them the function answers from open data
// and the cache, and says `fallback: null`. See handler.ts for the contract.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createAwsRoutesClient } from './aws.ts';
import { createSpeedLimitsDb, handleSpeedLimits } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'speed-limits');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'speed-limits'));
const db = createSpeedLimitsDb(
  createClient(url, requireApiKey('secret', 'speed-limits'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
);
const routes = createAwsRoutesClient(Deno.env);

Deno.serve((req) => handleSpeedLimits(req, { verifyJwt, db, routes }));
