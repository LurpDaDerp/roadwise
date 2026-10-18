// Entry point: the publishable-key client verifies the caller's token with Auth; the engine is a direct
// Postgres connection (SUPABASE_DB_URL) to the `private` schema. See handler.ts for the contract.
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createEngine } from '../_shared/engine.ts';
import { handleTripAction } from './handler.ts';

const verifyJwt = createVerifyJwt(requireEnv('SUPABASE_URL', 'trip-actions'), requireApiKey('publishable', 'trip-actions'));
const engine = createEngine(requireEnv('SUPABASE_DB_URL', 'trip-actions'));

Deno.serve((req) => handleTripAction(req, { verifyJwt, engine }));
