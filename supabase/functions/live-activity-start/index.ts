// Entry point: the publishable-key client verifies the caller's token with Auth and claims the
// device's push-to-start token as that caller (claim_live_activity_start, 0024); APNs is reached with
// the token-auth key in the function's secrets (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY,
// APNS_BUNDLE_ID). Without them every request answers `unconfigured`. See handler.ts for the contract.
import { apnsConfigFromEnv, createApnsClient } from '../_shared/apns.ts';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createClaim, handleLiveActivityStart } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'live-activity-start');
const publishableKey = requireApiKey('publishable', 'live-activity-start');
const verifyJwt = createVerifyJwt(url, publishableKey);
const claim = createClaim(url, publishableKey);
const config = apnsConfigFromEnv((name) => Deno.env.get(name));
const apns = config ? createApnsClient(config) : null;

Deno.serve((req) => handleLiveActivityStart(req, { verifyJwt, claim, apns }));
