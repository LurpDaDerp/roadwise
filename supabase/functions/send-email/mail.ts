// The mails RoadWise sends, and their delivery through Resend's HTTP API:
//   * `signup`: the code that confirms a new account's address (also its Resend code).
//   * `recovery`: the code that lets an email account's owner choose a new password.
//   * the sign-in reminder: Forgot password asked for an account that signs in with Apple or
//     Google and has no password; it says so, and carries no code.
//
// A mail carries nothing from the request but its code: no address, no name, no metadata (a
// sign-up's metadata is the requester's to set) and no link, so a mail scanner that opens links
// can't use it up and the code works whichever device reads the mail. The code also leads the
// subject, so the phone can offer it from the mail.

export interface Mail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** What a code is for: Auth's `email_action_type` of the two code mails RoadWise sends. */
export type CodeKind = 'signup' | 'recovery';

/** The longest Resend gets, when the hook has that much of Auth's 5 s left. */
export const RESEND_TIMEOUT_MS = 3_500;
export const RESEND_URL = 'https://api.resend.com/emails';

/** RESEND_FROM as sent: a bare address gets the RoadWise name ("RoadWise <no-reply@…>"). */
export function fromHeader(from: string): string {
  const trimmed = from.trim();
  return trimmed.includes('<') ? trimmed : `RoadWise <${trimmed}>`;
}

const COPY: Record<CodeKind, { subject: (code: string) => string; title: string; lead: string; ignore: string }> = {
  signup: {
    subject: (code) => `${code} is your RoadWise code`,
    title: 'Confirm your email',
    lead: 'Enter this code in RoadWise to finish setting up your account.',
    ignore: "Didn't sign up for RoadWise? Ignore this email. Nothing happens unless someone enters the code.",
  },
  recovery: {
    subject: (code) => `${code} is your RoadWise reset code`,
    title: 'Reset your password',
    lead: 'Enter this code in RoadWise to choose a new password.',
    ignore: "Didn't ask to reset your password? Ignore this email. Your password stays the same unless someone enters the code.",
  },
};

/** The one page every mail is laid out on: a title, a lead line, an optional code, and notes. */
function page(title: string, lead: string, code: string | null, notes: { text: string; strong?: boolean }[]): string {
  const codeBlock =
    code === null
      ? ''
      : `
                <p style="margin: 0 0 24px; padding: 16px 0; background-color: #ecece9; border-radius: 12px; text-align: center; font-family: 'SF Mono', Menlo, Consolas, 'Courier New', monospace; font-size: 32px; line-height: 40px; font-weight: 700; letter-spacing: 6px; color: #111113">${code}</p>`;
  const noteLines = notes
    .map(
      (n, i) =>
        `
                <p style="margin: 0 0 ${i === notes.length - 1 ? 0 : 8}px; font-size: 14px; line-height: 20px; color: ${n.strong ? '#111113; font-weight: 600' : '#4a4a4f'}">${n.text}</p>`
    )
    .join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>RoadWise</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f2">
      <tr>
        <td align="center" style="padding: 32px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 480px; background-color: #ffffff; border-radius: 16px">
            <tr>
              <td style="padding: 32px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111113">
                <p style="margin: 0 0 24px; font-size: 15px; font-weight: 700; letter-spacing: 0.5px">RoadWise</p>
                <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 30px; font-weight: 700">${title}</h1>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 24px; color: #4a4a4f">${lead}</p>${codeBlock}${noteLines}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

/** A code mail. `code` is Auth's numeric code, checked by the caller to be digits only. */
export function codeMail(kind: CodeKind, code: string, from: string, to: string): Mail {
  const copy = COPY[kind];
  const notes = [
    { text: 'It works for 10 minutes.' },
    { text: 'Never share this code. RoadWise will never ask you for it.', strong: true },
    { text: copy.ignore },
  ];
  const text = [copy.title, '', copy.lead, '', code, '', ...notes.map((n) => n.text)].join('\n');
  return { from: fromHeader(from), to, subject: copy.subject(code), html: page(copy.title, copy.lead, code, notes), text };
}

/** How an account without a password signs in, from Auth's `app_metadata.providers`. */
export type SignInWith = 'apple' | 'google' | 'apple_or_google';

const SIGN_IN_WITH: Record<SignInWith, { name: string; button: string }> = {
  apple: { name: 'Apple', button: 'Continue with Apple' },
  google: { name: 'Google', button: 'Continue with Google' },
  apple_or_google: { name: 'Apple or Google', button: 'Continue with Apple or Continue with Google' },
};

/**
 * Forgot password for an account that signs in with Apple or Google: there is no password to
 * reset, so the mail says how the account signs in, and carries no code.
 */
export function signInReminderMail(signInWith: SignInWith, from: string, to: string): Mail {
  const how = SIGN_IN_WITH[signInWith];
  const title = 'How you sign in to RoadWise';
  const lead = `You asked to reset your RoadWise password, but your account doesn't have one: you sign in with ${how.name}. Open RoadWise and select ${how.button}.`;
  const notes = [{ text: "Didn't ask? Ignore this email. Nothing about your account has changed." }];
  const text = [title, '', lead, '', ...notes.map((n) => n.text)].join('\n');
  return { from: fromHeader(from), to, subject: title, html: page(title, lead, null, notes), text };
}

export type Delivery = { sent: true } | { sent: false; status: number | null; reason: string };

export interface DeliveryOptions {
  /** How long Resend gets (default `RESEND_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Resend's Idempotency-Key: the hook call's `webhook-id`, so one call never mails twice. */
  idempotencyKey?: string;
}

/**
 * Sends one mail through Resend (POST /emails). Not sent: Resend's status and its error name (never
 * the mail or the address), or a null status when Resend didn't answer in time or at all.
 */
export async function sendWithResend(
  apiKey: string,
  mail: Mail,
  options: DeliveryOptions = {},
  fetchFn: typeof fetch = fetch
): Promise<Delivery> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetchFn(RESEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { sent: false, status: null, reason: err instanceof Error ? err.name : 'fetch_failed' };
  }
  if (res.ok) {
    await res.body?.cancel();
    return { sent: true };
  }
  let reason = 'unknown';
  try {
    const body = (await res.json()) as { name?: unknown };
    if (typeof body.name === 'string') reason = body.name.slice(0, 64);
  } catch {
    // Not JSON: the status says enough.
  }
  return { sent: false, status: res.status, reason };
}
