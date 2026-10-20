// Entry point: wires the handler to the runtime's clients. The publishable-key client verifies the
// caller's token with Auth (the signature and the user's existence); the secret-key client, which
// never leaves this process, calls the speed-limit functions (service-role only). The AWS client
// exists only when all three AWS secrets are set; without them the function answers from open data
// and the cache, and says `fallback: null`. The road-layer fill (fill.ts) runs its Overpass work
// past the response through `EdgeRuntime.waitUntil` when the runtime offers it, asking the
// operator's own Overpass instances (`OVERPASS_URL`) before the public ones. See handler.ts for the
// contract.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createAwsRoutesClient } from './aws.ts';
import { createOsmFill, createOsmFillDb } from './fill.ts';
import { overpassEndpoints, parseOverpassUrls } from './overpass.ts';
import { createSpeedLimitsDb, handleSpeedLimits } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'speed-limits');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'speed-limits'));
const client = createClient(url, requireApiKey('secret', 'speed-limits'), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const db = createSpeedLimitsDb(client);
const routes = createAwsRoutesClient(Deno.env);

interface EdgeRuntimeLike {
  waitUntil?: (work: Promise<unknown>) => void;
}
const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
const background = (work: Promise<void>): void => {
  if (runtime?.waitUntil) runtime.waitUntil(work);
  else void work;
};
// Optional: who to contact about this app's Overpass use, sent in the User-Agent (private.coffee's terms).
const contact = Deno.env.get('OVERPASS_CONTACT')?.trim() || null;
// Optional: the operator's Overpass instances, comma-separated, tried before the public ones (a
// keyed one such as NextGIS's, or one self-hosted). They can hold a key: only counts are logged.
const operator = parseOverpassUrls(Deno.env.get('OVERPASS_URL'));
if (operator.ignored > 0) console.warn('speed-limits OVERPASS_URL entries ignored', { ignored: operator.ignored, used: operator.urls.length });
const endpoints = overpassEndpoints(operator.urls);
const fill = createOsmFill({ db: createOsmFillDb(client), background, log: console, contact, endpoints });

Deno.serve((req) => handleSpeedLimits(req, { verifyJwt, db, routes, fill }));
