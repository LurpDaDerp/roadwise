// Entry point: wires the sweep handler to the runtime. The service client never leaves this
// process and calls only 0007's four push writers (`push_db.ts`). The gateway's JWT check is off
// for this function (`[functions.push-sender] verify_jwt = false`; deploy with `--no-verify-jwt`):
// the caller is pg_cron, authenticated by the signed sweep header alone. See handler.ts.
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_EXPO_PUSH_URL } from '../_shared/expo_push.ts';
import { createPushDb } from '../_shared/push_db.ts';
import { createPushSender, MIN_KEY_BYTES } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const hmacKey = Deno.env.get('PUSH_SENDER_HMAC_KEY');
if (!url || !serviceKey || !hmacKey) {
  throw new Error('push-sender needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and PUSH_SENDER_HMAC_KEY');
}
if (new TextEncoder().encode(hmacKey).byteLength < MIN_KEY_BYTES) {
  throw new Error(`push-sender needs a PUSH_SENDER_HMAC_KEY of at least ${MIN_KEY_BYTES} bytes`);
}
if (hmacKey === serviceKey) {
  throw new Error('push-sender refuses a PUSH_SENDER_HMAC_KEY equal to the service-role key');
}

const stateless = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const db = createPushDb(createClient(url, serviceKey, stateless));

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
