// Entry point: wires the handler to the runtime. The publishable-key client verifies the caller's
// token with Auth (the signature and the user's existence). No database, no secrets: the function
// only relays the app's Open-Meteo request. See handler.ts for the contract.
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { handleWeather } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'weather');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'weather'));

Deno.serve((req) => handleWeather(req, { verifyJwt }));
