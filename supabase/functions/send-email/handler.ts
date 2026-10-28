// send-email: Supabase Auth's Send Email hook, the only way RoadWise's Auth sends mail.
//
// Auth calls it (POST, signed with the hook secret) for every mail it would send, inside the
// request that wants the mail; an error answer fails that request, and the code it was about to
// store goes with it. So a code exists only for the one mail RoadWise sends:
//   * `signup` (a sign-up's confirmation code, also its Resend code): mailed through Resend, at most
//     5 an hour and 10 a day per inbox (`private.take_auth_mail` on `capKey`, else 429).
//   * A security notification (`*_notification`): carries no code; skipped without a mail, so a
//     notification switched on in the dashboard can't break the change it reports.
//   * Every other type (`recovery`, `magiclink`, `email`, `invite`, `email_change`,
//     `reauthentication`, and any new one): refused with 403. The app never asks for them, and
//     Auth's public endpoints would otherwise mint guessable codes for any address.
//
// Order, cheapest refusal first: method; the hook secret set and well formed (else 500, logged);
// the body (64 KB, streamed, else 413) and its signature (else 401); the payload's shape (else 400); the type; Resend
// set up (RESEND_API_KEY and RESEND_FROM, else 500, logged); the code is digits; the cap; the send
// (a refusal or no answer is 502).
//
// Answers to Auth: 200 `{}` when done. A refusal is 200 with `{ error: { http_code, message } }`:
// Auth fails the request with that status (a non-200 status of our own would reach the app only as
// a 500). A bad signature is a plain 401.
//
// Logs carry the request id, the type, the account id and reason codes: never the code, the
// address, the signature or the secret.
import { z } from 'zod';
import { json, requestId, type Logger } from '../_shared/http.ts';
import { codeMail, type Delivery, type Mail } from './mail.ts';
import { hookKeys, verifyHook } from './signature.ts';

/** Auth's hook payload is a few KB; nothing larger is read. */
export const MAX_BODY_BYTES = 65_536;
/** The codes RoadWise mails: Auth's `otp_length` digits (8; any length Auth allows passes). */
export const CODE_PATTERN = /^\d{6,10}$/;

export const HookPayloadSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.string() }).passthrough(),
  email_data: z.object({ token: z.string(), email_action_type: z.string().min(1) }).passthrough(),
});

export interface SendEmailLogger extends Logger {
  info(...args: unknown[]): void;
}

export interface SendEmailDeps {
  /** SEND_EMAIL_HOOK_SECRET: the same "v1,whsec_…" value as Auth's hook; null when unset. */
  hookSecret: string | null;
  /** RESEND_API_KEY; null when unset. */
  resendKey: string | null;
  /** RESEND_FROM: the From address on the domain verified in Resend; null when unset. */
  from: string | null;
  /** Takes one mail for the address with this SHA256; false when its cap is reached. */
  takeMail(addressHash: Uint8Array): Promise<boolean>;
  deliver(apiKey: string, mail: Mail): Promise<Delivery>;
  nowS(): number;
  log: SendEmailLogger;
}

const done = (): Response => json(200, {});
/** A refusal Auth turns into an error of `httpCode` for the request that wanted the mail. */
const refuse = (httpCode: number, message: string): Response => json(200, { error: { http_code: httpCode, message } });

/** Gmail ignores dots in the name and treats googlemail.com as gmail.com. */
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address the per-address cap counts against: lower-cased, a "+tag" dropped (for every
 * domain), and a Gmail name without its dots on gmail.com. Many spellings that reach one inbox
 * share one cap; the mail itself still goes to the address as given.
 */
export function capKey(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  let name = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = name.indexOf('+');
  if (plus > 0) name = name.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    name = name.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${name}@${domain}`;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * The body as text, or null when it is larger than `MAX_BODY_BYTES`: refused on a declared length
 * over the cap without reading, and cut off at the cap while streaming, so a chunked body with no
 * length is never buffered past it (the function is public: the signature is checked after this).
 */
async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

export function createSendEmail(deps: SendEmailDeps): (req: Request) => Promise<Response> {
  const { log } = deps;
  return async (req) => {
    const id = requestId();
    if (req.method !== 'POST') return json(405, { code: 'method_not_allowed' }, { allow: 'POST' });

    const keys = deps.hookSecret ? hookKeys(deps.hookSecret) : null;
    if (keys === null) {
      log.error('[send-email] SEND_EMAIL_HOOK_SECRET is unset or not "v1,whsec_<base64>": no mail is sent', { id });
      return refuse(500, 'Email is not set up.');
    }
    const body = await readBody(req);
    if (body === null) {
      log.warn('[send-email] refused: body over the size cap', { id });
      return json(413, { error: { http_code: 413, message: 'Payload too large.' } });
    }
    if (!(await verifyHook(keys, req.headers, body, deps.nowS()))) {
      log.warn('[send-email] refused: signature', { id });
      return json(401, { error: { http_code: 401, message: 'Invalid signature.' } });
    }

    let payload: z.infer<typeof HookPayloadSchema>;
    try {
      const parsed = HookPayloadSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error('shape');
      payload = parsed.data;
    } catch {
      log.warn('[send-email] refused: payload', { id });
      return refuse(400, 'Invalid payload.');
    }
    const type = payload.email_data.email_action_type;
    const user = payload.user.id;

    if (type.endsWith('_notification')) {
      log.info('[send-email] skipped', { id, type, user });
      return done();
    }
    if (type !== 'signup') {
      log.warn('[send-email] refused: type', { id, type, user });
      return refuse(403, 'RoadWise does not send this email.');
    }
    if (!deps.resendKey || !deps.from) {
      log.error('[send-email] RESEND_API_KEY or RESEND_FROM is unset: no mail is sent', { id, type, user });
      return refuse(500, 'Email is not set up.');
    }
    const code = payload.email_data.token;
    const to = payload.user.email.trim();
    if (!CODE_PATTERN.test(code) || !/^[^\s@]+@[^\s@]+$/.test(to)) {
      log.warn('[send-email] refused: code or address', { id, type, user });
      return refuse(400, 'Invalid payload.');
    }

    let allowed: boolean;
    try {
      allowed = await deps.takeMail(await sha256(capKey(to)));
    } catch (err) {
      log.error('[send-email] cap check failed: no mail is sent', { id, type, user, err: err instanceof Error ? err.name : 'unknown' });
      return refuse(500, 'The code could not be sent.');
    }
    if (!allowed) {
      log.warn('[send-email] refused: cap', { id, type, user });
      return refuse(429, 'Too many codes for this address. Try again later.');
    }

    const sent = await deps.deliver(deps.resendKey, codeMail(code, deps.from, to));
    if (!sent.sent) {
      log.error('[send-email] Resend did not send', { id, type, user, status: sent.status, reason: sent.reason });
      return refuse(502, 'The code could not be sent.');
    }
    log.info('[send-email] sent', { id, type, user });
    return done();
  };
}
