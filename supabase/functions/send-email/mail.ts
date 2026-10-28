// The one mail RoadWise sends: the sign-up confirmation code, and its delivery through Resend's
// HTTP API.
//
// The mail carries the code and nothing else from the request: no address, no name, no metadata
// (a sign-up's metadata is the requester's to set) and no link, so a mail scanner that opens links
// can't use it up and the code works whichever device reads the mail. The code also leads the
// subject, so the phone can offer it from the mail.

export interface Mail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** The longest Resend gets: Auth gives the whole hook call 5 s, and the cap check comes first. */
export const RESEND_TIMEOUT_MS = 3_500;
export const RESEND_URL = 'https://api.resend.com/emails';

/** RESEND_FROM as sent: a bare address gets the RoadWise name ("RoadWise <no-reply@…>"). */
export function fromHeader(from: string): string {
  const trimmed = from.trim();
  return trimmed.includes('<') ? trimmed : `RoadWise <${trimmed}>`;
}

/** The sign-up code mail. `code` is Auth's numeric code, checked by the caller to be digits only. */
export function codeMail(code: string, from: string, to: string): Mail {
  const subject = `${code} is your RoadWise code`;
  const text = [
    'Confirm your email',
    '',
    'Type this code into RoadWise to finish setting up your account:',
    '',
    code,
    '',
    'It works for 10 minutes.',
    'Never share this code. RoadWise will never ask you for it.',
    "Didn't sign up for RoadWise? You can ignore this email. Nothing happens unless the code is typed in.",
  ].join('\n');
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>Your RoadWise code</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f2">
      <tr>
        <td align="center" style="padding: 32px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 480px; background-color: #ffffff; border-radius: 16px">
            <tr>
              <td style="padding: 32px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111113">
                <p style="margin: 0 0 24px; font-size: 15px; font-weight: 700; letter-spacing: 0.5px">RoadWise</p>
                <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 30px; font-weight: 700">Confirm your email</h1>
                <p style="margin: 0 0 24px; font-size: 16px; line-height: 24px; color: #4a4a4f">Type this code into RoadWise to finish setting up your account.</p>
                <p style="margin: 0 0 24px; padding: 16px 0; background-color: #ecece9; border-radius: 12px; text-align: center; font-family: 'SF Mono', Menlo, Consolas, 'Courier New', monospace; font-size: 32px; line-height: 40px; font-weight: 700; letter-spacing: 6px; color: #111113">${code}</p>
                <p style="margin: 0 0 8px; font-size: 14px; line-height: 20px; color: #4a4a4f">It works for 10 minutes.</p>
                <p style="margin: 0 0 8px; font-size: 14px; line-height: 20px; color: #111113; font-weight: 600">Never share this code. RoadWise will never ask you for it.</p>
                <p style="margin: 0; font-size: 14px; line-height: 20px; color: #4a4a4f">Didn't sign up for RoadWise? You can ignore this email. Nothing happens unless the code is typed in.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  return { from: fromHeader(from), to, subject, html, text };
}

export type Delivery = { sent: true } | { sent: false; status: number | null; reason: string };

/**
 * Sends one mail through Resend (POST /emails). Not sent: Resend's status and its error name (never
 * the mail or the address), or a null status when Resend didn't answer in time or at all.
 */
export async function sendWithResend(apiKey: string, mail: Mail, fetchFn: typeof fetch = fetch): Promise<Delivery> {
  let res: Response;
  try {
    res = await fetchFn(RESEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
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
