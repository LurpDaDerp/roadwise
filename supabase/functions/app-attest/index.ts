// Entry point: the publishable-key client verifies the caller's token with Auth; the challenges and
// keys are kept over a direct Postgres connection (SUPABASE_DB_URL) to the `private` schema, which
// the Data API never exposes. App Attest's own secrets: APP_ATTEST_TEAM_ID (the Apple team id;
// without it every request answers `unconfigured`), APP_ATTEST_BUNDLE_ID (default
// com.lurp.safedrive) and APP_ATTEST_ALLOW_DEVELOPMENT (true: Apple's sandbox keys are accepted too).
// See handler.ts for the contract.
import { attestSettingsFromEnv } from '../_shared/appattest.ts';
import { createAttestStore } from '../_shared/appattest_store.ts';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { handleAppAttest } from './handler.ts';

const verifyJwt = createVerifyJwt(requireEnv('SUPABASE_URL', 'app-attest'), requireApiKey('publishable', 'app-attest'));
const store = createAttestStore(requireEnv('SUPABASE_DB_URL', 'app-attest'));
const settings = await attestSettingsFromEnv((name) => Deno.env.get(name), console);

Deno.serve((req) => handleAppAttest(req, { verifyJwt, store, settings }));
