// Entry point: the publishable-key client verifies the caller's token with Auth; the engine is a direct
// Postgres connection (SUPABASE_DB_URL) to the `private` schema, which the Data API never exposes.
// App Attest (attest.ts) reads APP_ATTEST_TEAM_ID, APP_ATTEST_BUNDLE_ID, APP_ATTEST_ALLOW_DEVELOPMENT
// and APP_ATTEST_ENFORCE; enforcing without a valid team id is a startup error, never a silent pass.
import { attestEnforced, attestSettingsFromEnv } from '../_shared/appattest.ts';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createEngine } from '../_shared/engine.ts';
import { handleFinalizeTrip } from './handler.ts';

const verifyJwt = createVerifyJwt(requireEnv('SUPABASE_URL', 'finalize-trip'), requireApiKey('publishable', 'finalize-trip'));
const engine = createEngine(requireEnv('SUPABASE_DB_URL', 'finalize-trip'));
const env = (name: string) => Deno.env.get(name);
const settings = await attestSettingsFromEnv(env, console);
const enforce = attestEnforced(env);
if (enforce && !settings) throw new Error('finalize-trip needs APP_ATTEST_TEAM_ID to enforce App Attest');

Deno.serve((req) => handleFinalizeTrip(req, { verifyJwt, engine, attest: { settings, enforce } }));
