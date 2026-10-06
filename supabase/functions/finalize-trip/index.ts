// Entry point: the anon client verifies the caller's token with Auth; the engine is a direct
// Postgres connection (SUPABASE_DB_URL) to the `private` schema, which the Data API never exposes.
import { createVerifyJwt, requireEnv } from '../_shared/auth.ts';
import { createEngine } from '../_shared/engine.ts';
import { handleFinalizeTrip } from './handler.ts';

const verifyJwt = createVerifyJwt(requireEnv('SUPABASE_URL', 'finalize-trip'), requireEnv('SUPABASE_ANON_KEY', 'finalize-trip'));
const engine = createEngine(requireEnv('SUPABASE_DB_URL', 'finalize-trip'));

Deno.serve((req) => handleFinalizeTrip(req, { verifyJwt, engine }));
