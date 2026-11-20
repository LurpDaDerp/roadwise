// send-email: Supabase Auth's Send Email hook, the only way RoadWise's Auth sends mail.
//
// Auth calls it (POST, signed with the hook secret) for every mail it would send, inside the
// request that wants the mail; an error answer fails that request, and the code it was about to
// store goes with it. So a code exists only for the two mails RoadWise sends:
//   * `signup` (a sign-up's confirmation code, also its Resend code) and `recovery` (the code that
//     lets an email account's owner choose a new password): mailed through Resend, all kinds
//     together within the caps of `private.take_auth_mail` (0045), else 429. With the IP Auth
//     reports: 5 an hour and 10 a day to an inbox from one IP, 20 and 30 to an inbox from all IPs,
//     20 and 50 from one IP to all inboxes, so no one requester can use up an inbox's mails and
//     lock its owner out; with no IP, 5 and 10 per inbox.
//   * `recovery` for an account with no email sign-in (Apple or Google only, by Auth's
//     `app_metadata.providers`): no code goes out, so Forgot password never hands an Apple or
//     Google account to whoever reads its mailbox; the account gets a mail saying how it signs in
//     (the same caps), and Auth's answer to the requester is the same as for a code.
//   * A security notification (`*_notification`): carries no code; skipped without a mail, so a
//     notification switched on in the dashboard can't break the change it reports.
//   * Every other type (`magiclink`, `email`, `invite`, `email_change`, `reauthentication`,
//     and any new one): refused with 403. The app never asks for them, and Auth's public endpoints
//     would otherwise mint codes for any address.
//
// Order, cheapest refusal first: method; the hook secret set and well formed (else 500, logged);
// the body (64 KB, streamed, else 413) and its signature (else 401); the payload's shape (else
// 400); the type; Resend set up (RESEND_API_KEY and RESEND_FROM, else 500, logged); the code is
// digits; the caps; time left (else 504); the send (a refusal or no answer is 502).
//
// Auth gives the whole call 5 s, so the hook works to its own deadline of `DEADLINE_MS` from the
// call's start: Resend gets what is left of it (at most 3.5 s), and with less than `MIN_SEND_MS`
// left nothing is sent, so a mail never goes out for a request Auth has already failed. Resend
// gets the call's `webhook-id` as its Idempotency-Key.
//
// Answers to Auth: 200 `{}` when done. A refusal is 200 with `{ error: { http_code, message } }`:
// Auth fails the request with that status (a non-200 status of our own would reach the app only as
// a 500). A bad signature is a plain 401.
//
// Logs carry the request id, the type, the account id and reason codes: never the code, the
// address, the signature or the secret.
import { z } from 'zod';
import { json, requestId, type Logger } from '../_shared/http.ts';
import {
  codeMail,
  RESEND_TIMEOUT_MS,
  signInReminderMail,
  type CodeKind,
  type Delivery,
  type DeliveryOptions,
  type Mail,
  type SignInWith,
} from './mail.ts';
import { hookKeys, verifyHook } from './signature.ts';

/** Auth's hook payload is a few KB; nothing larger is read. */
export const MAX_BODY_BYTES = 65_536;
/** The codes RoadWise mails: Auth's `otp_length` digits (8; any length Auth allows passes). */
export const CODE_PATTERN = /^\d{6,10}$/;

/** The hook's own deadline, from the start of Auth's call (Auth allows 5 s for all of it). */
export const DEADLINE_MS = 4_200;
/** The least time worth handing Resend; with less left, nothing is sent. */
export const MIN_SEND_MS = 800;

export const HookPayloadSchema = z.object({
  user: z
    .object({
      id: z.string().min(1),
      email: z.string(),
      app_metadata: z.object({ providers: z.array(z.string()).optional() }).passthrough().optional(),
    })
    .passthrough(),
  email_data: z.object({ token: z.string(), email_action_type: z.string().min(1) }).passthrough(),
  metadata: z.object({ ip_address: z.string().optional() }).passthrough().optional(),
});

/** What `private.take_auth_mail` answers: taken, or which cap is full. */
export type CapAnswer = 'ok' | 'pair' | 'address' | 'ip';

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
  /**
   * Takes one mail for the inbox, the inbox from this IP and the IP with these SHA-256s (pair and
   * ip null: no IP reported), all or none.
   */
  takeMail(addressHash: Uint8Array, pairHash: Uint8Array | null, ipHash: Uint8Array | null): Promise<CapAnswer>;
  deliver(apiKey: string, mail: Mail, options: DeliveryOptions): Promise<Delivery>;
  nowS(): number;
  nowMs(): number;
  log: SendEmailLogger;
}

const done = (): Response => json(200, {});
const isCodeKind = (type: string): type is CodeKind => type === 'signup' || type === 'recovery';
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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A dotted IPv4 address as its canonical text, or null. */
function ipv4(text: string): string | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts.join('.') : null;
}

/** An IPv6 address as its 8 hextets (an embedded IPv4 tail as the last two), or null. */
function ipv6Hextets(text: string): number[] | null {
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    const v4 = ipv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left === null || right === null) return null;
  const given = left.length + right.length + tail.length;
  if (halves.length === 1) return given === 8 ? [...left, ...tail] : null;
  if (given > 7) return null;
  return [...left, ...new Array<number>(8 - given).fill(0), ...right, ...tail];
}

/**
 * The IP caps' key, from the address Auth reports for the request: "ip:" and an IPv4 address, or
 * "ip:" and an IPv6 address's /64 network (one subscriber's line or phone holds a whole /64, so
 * counting single IPv6 addresses would cap nothing); an IPv4 address written as IPv6
 * (::ffff:a.b.c.d) counts as that IPv4 address. Null when Auth reports none (an older Auth) or
 * something that is not an IP address.
 */
export function ipKey(ip: string | undefined): string | null {
  const value = (ip ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (value.length === 0 || value.length > 64) return null;
  const v4 = ipv4(value);
  if (v4 !== null) return `ip:${v4}`;
  const h = ipv6Hextets(value);
  if (h === null) return null;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return `ip:${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  }
  return `ip:${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Whether Forgot password may mail this account a code: only when it signs in with an email and a
 * password (`email` among its providers). With no list, it may not: a code would make the
 * account's mailbox a way in that the account never had.
 */
export function hasEmailSignIn(providers: readonly string[] | undefined): boolean {
  return Array.isArray(providers) && providers.includes('email');
}

/** How an account with no email sign-in signs in, for its reminder. */
export function signInWith(providers: readonly string[] | undefined): SignInWith {
  const apple = providers?.includes('apple') ?? false;
  const google = providers?.includes('google') ?? false;
  return apple && !google ? 'apple' : google && !apple ? 'google' : 'apple_or_google';
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
    const startedMs = deps.nowMs();
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
    if (!isCodeKind(type)) {
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

    // Forgot password for an account with no password of its own gets the reminder, not a code.
    const providers = payload.user.app_metadata?.providers;
    const reminder = type === 'recovery' && !hasEmailSignIn(providers);
    const mail = reminder
      ? signInReminderMail(signInWith(providers), deps.from, to)
      : codeMail(type, code, deps.from, to);
    const kind = reminder ? 'reminder' : type;

    const inbox = capKey(to);
    const ip = ipKey(payload.metadata?.ip_address);
    let cap: CapAnswer;
    try {
      cap = await deps.takeMail(
        await sha256(inbox),
        ip === null ? null : await sha256(`pair:${inbox}|${ip}`),
        ip === null ? null : await sha256(ip)
      );
    } catch (err) {
      log.error('[send-email] cap check failed: no mail is sent', { id, kind, user, err: err instanceof Error ? err.name : 'unknown' });
      return refuse(500, 'The code could not be sent.');
    }
    if (cap !== 'ok') {
      log.warn('[send-email] refused: cap', { id, kind, user, cap });
      return refuse(429, 'Too many codes asked for. Try again later.');
    }

    const left = startedMs + DEADLINE_MS - deps.nowMs();
    if (left < MIN_SEND_MS) {
      log.error('[send-email] out of time before the send: no mail is sent', { id, kind, user, left });
      return refuse(504, 'The code could not be sent.');
    }
    const webhookId = req.headers.get('webhook-id') ?? undefined;
    const sent = await deps.deliver(deps.resendKey, mail, {
      timeoutMs: Math.min(RESEND_TIMEOUT_MS, left - 100),
      idempotencyKey: webhookId,
    });
    if (!sent.sent) {
      log.error('[send-email] Resend did not send', { id, kind, user, status: sent.status, reason: sent.reason });
      return refuse(502, 'The code could not be sent.');
    }
    log.info('[send-email] sent', { id, kind, user, capped_by_ip: ip !== null });
    return done();
  };
}
