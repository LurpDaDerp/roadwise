// Entry point: the anon client verifies the caller's token with Auth; the engine is a direct
// Postgres connection (SUPABASE_DB_URL) to the `private` schema. See handler.ts for the contract.
import { createVerifyJwt, requireEnv } from '../_shared/auth.ts';
import { createEngine } from '../_shared/engine.ts';
import { handleTripAction } from './handler.ts';

const verifyJwt = createVerifyJwt(requireEnv('SUPABASE_URL', 'trip-actions'), requireEnv('SUPABASE_ANON_KEY', 'trip-actions'));
const engine = createEngine(requireEnv('SUPABASE_DB_URL', 'trip-actions'));

Deno.serve((req) => handleTripAction(req, { verifyJwt, engine }));
