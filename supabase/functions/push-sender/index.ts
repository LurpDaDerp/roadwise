// Entry point: wires the sweep handler to the runtime. The secret-key client never leaves this
// process and calls only 0005's push writers (`push_db.ts`). The gateway's JWT check is off
// for this function (`[functions.push-sender] verify_jwt = false`; deploy with `--no-verify-jwt`):
// the caller is pg_cron, authenticated by the signed sweep header alone. See handler.ts.
import { createClient } from '@supabase/supabase-js';
import { requireApiKey, requireEnv } from '../_shared/auth.ts';
import { DEFAULT_EXPO_PUSH_URL } from '../_shared/expo_push.ts';
import { createPushDb } from '../_shared/push_db.ts';
import { MIN_SWEEP_KEY_BYTES, sweepKeyUsable } from '../_shared/sweep_auth.ts';
import { createPushSender } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'push-sender');
const secretKey = requireApiKey('secret', 'push-sender');
const hmacKey = requireEnv('PUSH_SENDER_HMAC_KEY', 'push-sender');
if (!sweepKeyUsable(hmacKey)) {
  throw new Error(`push-sender needs a PUSH_SENDER_HMAC_KEY of at least ${MIN_SWEEP_KEY_BYTES} bytes`);
}
if (hmacKey === secretKey) {
  throw new Error('push-sender refuses a PUSH_SENDER_HMAC_KEY equal to the secret key');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const db = createPushDb(createClient(url, secretKey, stateless));

Deno.serve(
  createPushSender({
    hmacKey,
    db,
    expo: {
      url: Deno.env.get('EXPO_PUSH_URL') || DEFAULT_EXPO_PUSH_URL,
      accessToken: Deno.env.get('EXPO_ACCESS_TOKEN') || null,
    },
  })
);
