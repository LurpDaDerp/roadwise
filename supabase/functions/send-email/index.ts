// Entry point: Supabase Auth's Send Email hook (handler.ts). Auth calls it with the hook signature,
// not a user's JWT, so the gateway's JWT check is off ([functions.send-email] verify_jwt = false;
// deploy with --no-verify-jwt).
//
// Its secrets (`supabase secrets set`, never in the app or git):
//   SEND_EMAIL_HOOK_SECRET  the hook's "v1,whsec_<base64>" secret, the same value as Auth's
//                           [auth.hook.send_email] secrets
//   RESEND_API_KEY          the Resend API key (sending access, the RoadWise domain only)
//   RESEND_FROM             the From address on the domain verified in Resend, such as
//                           no-reply@<domain> (a bare address is sent as "RoadWise <…>")
// Without any of them the function sends nothing and says so in its log on every call, and Auth
// fails the request, so no code is stored. The cap is kept over a direct Postgres connection
// (SUPABASE_DB_URL, which the runtime sets).
import { requireEnv } from '../_shared/auth.ts';
import { createSendEmail } from './handler.ts';
import { sendWithResend } from './mail.ts';
import { createMailCap } from './store.ts';

const optional = (name: string): string | null => Deno.env.get(name)?.trim() || null;

const hookSecret = optional('SEND_EMAIL_HOOK_SECRET');
const resendKey = optional('RESEND_API_KEY');
const from = optional('RESEND_FROM');
for (const [name, value] of [
  ['SEND_EMAIL_HOOK_SECRET', hookSecret],
  ['RESEND_API_KEY', resendKey],
  ['RESEND_FROM', from],
] as const) {
  if (!value) console.error(`[send-email] ${name} is unset: no mail will be sent until it is set`);
}
const cap = createMailCap(requireEnv('SUPABASE_DB_URL', 'send-email'));

Deno.serve(
  createSendEmail({
    hookSecret,
    resendKey,
    from,
    takeMail: (hash) => cap.take(hash),
    deliver: (apiKey, mail) => sendWithResend(apiKey, mail),
    nowS: () => Math.floor(Date.now() / 1000),
    log: console,
  })
);
