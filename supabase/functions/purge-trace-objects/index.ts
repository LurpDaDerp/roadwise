// Entry point: wires the handler to the service-role client, which never leaves this process. No
// client ever calls this function: pg_cron wakes it through pg_net with a signed header (see
// handler.ts), and `verify_jwt = false` in config.toml because no JWT is sent.
import { createClient } from '@supabase/supabase-js';
import { createPurgePorts, handlePurge } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) {
  throw new Error('purge-trace-objects needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
}
// Read per request, so a rotated secret is picked up by the next warm worker; checked in the handler.
const hmacKey = (): string | undefined => Deno.env.get('PURGE_TRACES_HMAC_KEY');

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const { db, storage } = createPurgePorts(createClient(url, serviceKey, stateless));

Deno.serve((req) => handlePurge(req, { hmacKey: hmacKey(), db, storage }));
