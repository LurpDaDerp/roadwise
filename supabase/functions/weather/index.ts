// Entry point: wires the handler to the runtime. The publishable-key client verifies the caller's
// token with Auth (the signature and the user's existence); the secret-key client, which never
// leaves this process, spends the rate-limit budgets (service-role only functions). See handler.ts
// for the contract.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createWeatherDb, handleWeather } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'weather');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'weather'));
const client = createClient(url, requireApiKey('secret', 'weather'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const db = createWeatherDb(client);

Deno.serve((req) => handleWeather(req, { verifyJwt, db }));
