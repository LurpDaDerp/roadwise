import { supabase } from '@/data/supabase/client';

import { createAsideAuth, type AsideAuth } from './asideAuth';

/** The shortest password; the server's `minimum_password_length` (supabase/config.toml) says the same. */
export const PASSWORD_MIN = 8;

/** The longest password Auth takes (it hashes at most 72 bytes and refuses anything longer). */
export const PASSWORD_MAX = 72;

/** Digits in the code a mail carries: the server's `otp_length` (supabase/config.toml). */
export const CODE_LENGTH = 8;

/**
 * Seconds before Resend code can send another mail: the server's `max_frequency` in production
 * (supabase/config.toml), which refuses a second mail to one address sooner.
 */
export const RESEND_COOLDOWN_S = 60;

/** The length of a string in UTF-8 bytes, as Auth measures a password (a lone surrogate counts 3, as U+FFFD). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * What is wrong with a new password: the server's rules (`minimum_password_length`,
 * `password_requirements = "letters_digits"`, 72 bytes), and `common`, the app's own: a password
 * too easy to guess (only the app checks this one; it keeps drivers from choosing one).
 */
export type PasswordProblem = 'short' | 'long' | 'letters_digits' | 'common';

/**
 * Words and keyboard runs that make a password easy to guess, as letters only, lower case, with
 * look-alike digits and symbols read as letters ("P@ssw0rd" is "password").
 */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'password', 'passwort', 'pass', 'qwerty', 'qwertz', 'azerty', 'qwertyuiop', 'asdf', 'asdfgh', 'asdfghjkl', 'zxcv',
  'zxcvbn', 'zxcvbnm', 'qazwsx', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg', 'iloveyou', 'loveyou', 'love', 'welcome',
  'letmein', 'monkey', 'dragon', 'football', 'baseball', 'basketball', 'soccer', 'hockey', 'sunshine', 'princess',
  'master', 'admin', 'administrator', 'test', 'tester', 'testing', 'hello', 'freedom', 'whatever', 'starwars',
  'computer', 'internet', 'secret', 'superman', 'batman', 'shadow', 'michael', 'jordan', 'charlie', 'jessica', 'ashley',
  'summer', 'winter', 'spring', 'autumn', 'angel', 'killer', 'trustno', 'flower', 'pokemon', 'google', 'apple',
  'iphone', 'samsung', 'roadwise', 'driver', 'driving', 'mustang', 'ferrari', 'liverpool', 'chelsea', 'arsenal',
  'cookie', 'cheese', 'chocolate', 'purple', 'orange', 'banana', 'matrix', 'hunter', 'ranger', 'harley', 'babygirl',
  'loveme', 'family', 'friends', 'changeme', 'default', 'guest', 'user', 'login', 'qwe', 'asd', 'zxc', 'qweasd',
  'qweasdzxc', 'qwer', 'asdfjkl', 'myspace', 'facebook', 'instagram', 'tiktok', 'youtube', 'minecraft', 'fortnite',
]);

/** Keyboard and counting runs anywhere in a password. */
const COMMON_RUNS = ['qwerty', 'asdfgh', 'zxcvbn', '1qaz', 'qaz2', '1q2w', 'q1w2', '2wsx', 'abcdef', '123456', '654321', 'password'];

/** Look-alike digits and symbols read as the letters they stand for. */
const LOOK_ALIKE: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '!': 'i', '3': 'e', '5': 's', $: 's', '7': 't' };

/** Whether a password is too easy to guess: a common word or run, almost no letters, or the email's name. */
function isCommonPassword(password: string, email: string | undefined): boolean {
  const lower = password.toLowerCase();
  if (COMMON_RUNS.some((run) => lower.includes(run))) return true;
  const letters = lower.replace(/[^a-z]/g, '');
  // Letters of any alphabet (a to z, and everything past ASCII: an accent, Cyrillic, kana), so a
  // passphrase in another script with one a-to-z letter isn't read as almost no letters.
  const anyLetters = [...lower].filter((ch) => (ch >= 'a' && ch <= 'z') || ch > '\u007f');
  // "a1234567", "ab123456", "aaaa1111": a number with a letter or two, or one letter over and over.
  if (anyLetters.length <= 2 || new Set(anyLetters).size === 1) return true;
  // The word with the digits and symbols at its ends dropped, and look-alikes read as letters.
  const core = lower
    .replace(/^[^a-z@$!]+|[^a-z]+$/g, '')
    .replace(/[@$!0-9]/g, (ch) => LOOK_ALIKE[ch] ?? '')
    .replace(/[^a-z]/g, '');
  if (COMMON_WORDS.has(core) || COMMON_WORDS.has(letters)) return true;
  const name = (email ?? '').trim().toLowerCase().split('@')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
  return name.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(name);
}

/**
 * Why a new password can't be used, or null when it can: at least `PASSWORD_MIN` characters (as
 * Auth counts them, by code point), at most `PASSWORD_MAX` bytes, at least one letter (a to z,
 * either case) and one digit, and not too easy to guess (`common`; with the account's email, not
 * containing its name).
 */
export function passwordProblem(password: string, email?: string): PasswordProblem | null {
  if ([...password].length < PASSWORD_MIN) return 'short';
  if (utf8Bytes(password) > PASSWORD_MAX) return 'long';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'letters_digits';
  if (isCommonPassword(password, email)) return 'common';
  return null;
}

/** An address shaped like one; Auth makes the final call (`invalid_email`). */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RegisterResult =
  | 'ok'
  | 'confirm_email'
  | 'exists'
  | 'weak_password'
  | 'invalid_email'
  | 'rate_limited'
  | 'offline'
  | 'error';
export type SignInResult = 'ok' | 'invalid' | 'unconfirmed' | 'rate_limited' | 'offline' | 'error';
/** `unfinished`: the code was right, but the account could not be made the driver's yet (Try again). */
export type VerifyResult = 'ok' | 'wrong_code' | 'rate_limited' | 'offline' | 'unfinished' | 'error';
/**
 * `too_soon`: Auth's one-mail-a-minute refusal for this address, so a code went out within the
 * minute and still works. `rate_limited`: any other refusal for too many (the per-address cap of
 * the send-email hook, the project's hourly mails, too many requests): no code went out.
 */
export type ResendResult = 'sent' | 'too_soon' | 'rate_limited' | 'offline' | 'error';

/** What a code is for: confirming a new account's address, or choosing a new password. */
export type CodeKind = 'signup' | 'recovery';

const codeOf = (error: unknown): { status?: unknown; code?: unknown; name?: unknown } =>
  typeof error === 'object' && error !== null ? (error as { status?: unknown; code?: unknown; name?: unknown }) : {};

/** Auth refuses a burst of attempts with HTTP 429 (`over_request_rate_limit`, `over_email_send_rate_limit`). */
const isRateLimited = (error: unknown): boolean => {
  const { status, code } = codeOf(error);
  return status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit';
};

/**
 * Auth's refusal of a second mail to one address within `max_frequency` ("you can only request
 * this after N seconds"). The project's hourly cap shares its code (`over_email_send_rate_limit`)
 * but not its words, and no code went out then, so both must match; anything else reads as no code.
 */
const isTooSoon = (error: unknown): boolean => {
  const { code } = codeOf(error);
  const message = (error as { message?: unknown } | null)?.message;
  return code === 'over_email_send_rate_limit' && typeof message === 'string' && /after \d+ seconds?/i.test(message);
};

/** A request that never reached Auth: supabase-js answers it with a retryable fetch error, status 0. */
const isOffline = (error: unknown): boolean => {
  const { status, name } = codeOf(error);
  return name === 'AuthRetryableFetchError' && status === 0;
};

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Creates the account. With email confirmations on (supabase/config.toml) the answer carries no
 * session and Auth mails an 8-digit code to the address: `confirm_email`, and the code screen takes
 * it from there (also when Auth refuses a second mail within the minute: the first still works). An address that already has a confirmed account gets the same quiet answer from
 * Auth, but with a stand-in user that has no identities and no mail sent, so it reads as `exists`.
 * An answer with a session (a project with confirmations off) is `ok`: the driver is in at once.
 */
export async function registerWithPassword(email: string, password: string): Promise<RegisterResult> {
  let answer: Awaited<ReturnType<typeof supabase.auth.signUp>>;
  try {
    answer = await supabase.auth.signUp({ email: normalise(email), password });
  } catch {
    return 'error';
  }
  const { data, error } = answer;
  if (error) {
    const { code } = codeOf(error);
    // A sign-up to this unconfirmed address within the last minute mailed a code that still works.
    if (isTooSoon(error)) return 'confirm_email';
    if (isRateLimited(error)) return 'rate_limited';
    if (isOffline(error)) return 'offline';
    if (code === 'user_already_exists' || code === 'email_exists') return 'exists';
    if (code === 'weak_password') return 'weak_password';
    if (code === 'email_address_invalid' || code === 'validation_failed') return 'invalid_email';
    return 'error';
  }
  if (data.session) return 'ok';
  const identities = data.user?.identities;
  return Array.isArray(identities) && identities.length === 0 ? 'exists' : 'confirm_email';
}

/**
 * Email and password for an account that exists. A wrong email and a wrong password read the same.
 * The right password on an account whose address was never confirmed is `unconfirmed` (Auth checks
 * the password first, so only its holder learns that).
 */
export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  let error: unknown;
  try {
    ({ error } = await supabase.auth.signInWithPassword({ email: normalise(email), password }));
  } catch {
    return 'error';
  }
  if (!error) return 'ok';
  if (isRateLimited(error)) return 'rate_limited';
  if (isOffline(error)) return 'offline';
  const { code } = codeOf(error);
  if (code === 'email_not_confirmed') return 'unconfirmed';
  return code === 'invalid_credentials' ? 'invalid' : 'error';
}

/** One address's code, from the code screen: see `startEmailConfirmation`. */
export type EmailConfirmation = {
  /** Checks the code from the mail and, when it is right, finishes the account and signs in. */
  verify: (code: string) => Promise<VerifyResult>;
  /** Finishes again after `unfinished` (the code is spent by then). */
  finish: () => Promise<VerifyResult>;
  /** The driver left the code screen: a session the code signed in, not yet handed over, is signed out. */
  abandon: () => Promise<void>;
};

/**
 * The least life a held session's access token must have left before the steps that finish an
 * account: any less and it is refreshed first.
 */
const FRESH_FOR_MS = 5 * 60_000;

type HeldSession = { access_token: string; refresh_token: string; expires_at?: number };

/**
 * An `updateUser` refusal that trying again can't change (Auth's 4xx other than 429, such as
 * `weak_password` or `reauthentication_needed`), as opposed to no connection, a 5xx or a 429.
 */
const isPermanent = (error: unknown): boolean => {
  const { status } = codeOf(error);
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429 && !isOffline(error);
};

/**
 * Checks a mailed code, failing closed: the sign-up code that confirms an address (`signup`), or the
 * Forgot password code (`recovery`). Auth keeps the password of the first sign-up to an address
 * until the address is confirmed (a second sign-up neither replaces it nor is refused: Auth just
 * mails a new code), and a reset code confirms an address too, so an account someone else
 * registered to the driver's address, and could never confirm, would otherwise come out of the
 * driver's code carrying that person's password. So the session the right code signs in stays on an
 * aside client (`createAsideAuth`), out of the app's sight, until:
 * 0. its access token has at least 5 minutes left (it is refreshed first when not: the aside client
 *    never refreshes on its own, and Try again can come much later);
 * 1. `chosenPassword` is the account's (`updateUser`): the new account's (or the one typed to sign
 *    in to an unconfirmed account), or the new one after Forgot password. The server clears any
 *    password an address had when it is first confirmed (0045), so this is always set; Auth's
 *    `same_password` refusal means it already is, and a change also signs out every other session;
 * 2. every other session of the account is signed out, checked through Auth's answer to the
 *    logout itself (the client's own `signOut` lets a 401, 403 or 404 pass as done);
 * 3. the app's client takes the session over (`setSession`), which signs the driver in.
 * Any of those failing is `unfinished`: the driver is not signed in, and `finish` tries again with
 * the same session; a password Auth refuses for good (`isPermanent`) is `error` instead, and the
 * session goes, since trying again can't help (the driver starts over: a new code, or Forgot
 * password). Auth answers a wrong code and an expired one alike (`otp_expired`), so both are
 * `wrong_code`.
 */
export function startEmailConfirmation(
  email: string,
  chosenPassword: string,
  kind: CodeKind = 'signup'
): EmailConfirmation {
  const address = normalise(email);
  let aside: AsideAuth | null = null;
  // The aside client holds the session the right code signed in, not yet handed to the app.
  let holding = false;
  let abandoned = false;

  const revoke = async (client: AsideAuth) => {
    try {
      await client.signOut({ scope: 'local' });
    } catch {
      // Gone with the screen either way: nothing on the phone holds it.
    }
  };

  /** The held session with at least `FRESH_FOR_MS` left, refreshed first when it has less; null when it can't be. */
  const liveSession = async (client: AsideAuth): Promise<HeldSession | null> => {
    const { data, error } = await client.getSession();
    if (error || !data.session) return null;
    const { expires_at: expiresAt } = data.session;
    if (expiresAt !== undefined && expiresAt * 1000 - Date.now() > FRESH_FOR_MS) return data.session;
    const { data: refreshed, error: refreshError } = await client.refreshSession();
    return refreshError || !refreshed.session ? null : refreshed.session;
  };

  const finish = async (): Promise<VerifyResult> => {
    const client = aside;
    if (client === null || !holding || abandoned) return 'error';
    let session: HeldSession | null;
    try {
      session = await liveSession(client);
      if (session === null) return 'unfinished';
      const { error } = await client.updateUser({ password: chosenPassword });
      if (error && codeOf(error).code !== 'same_password') {
        if (!isPermanent(error)) return 'unfinished';
        holding = false;
        aside = null;
        await revoke(client);
        return 'error';
      }
      const { error: othersError } = await client.admin.signOut(session.access_token, 'others');
      if (othersError) return 'unfinished';
    } catch {
      return 'unfinished';
    }
    if (abandoned) return 'unfinished';
    // The app's client takes the session over from here: leaving the screen meanwhile (its route
    // changes as the driver signs in) must not sign that session out.
    holding = false;
    let handedOver = false;
    try {
      const { error } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      handedOver = !error;
    } catch {
      handedOver = false;
    }
    if (!handedOver) {
      if (abandoned) await revoke(client);
      else holding = true;
      return 'unfinished';
    }
    // The app's client owns the session now; the aside one must never use it again.
    aside = null;
    return 'ok';
  };

  // The address is confirmed from the right code on, so a code check left before it finished makes
  // one more try at steps 1 and 2 before the session goes: a confirmed account must not keep a
  // password someone else set. Best effort; offline it leaves things as they were.
  const secureBeforeLeaving = async (client: AsideAuth, password: string) => {
    try {
      const session = await liveSession(client);
      if (session === null) return;
      await client.updateUser({ password });
      await client.admin.signOut(session.access_token, 'others');
    } catch {
      // Left as it was.
    }
  };

  /** The confirmed session goes with the screen, after one more try at steps 1 and 2. */
  const leave = async (client: AsideAuth) => {
    await secureBeforeLeaving(client, chosenPassword);
    await revoke(client);
  };

  const verify = async (code: string): Promise<VerifyResult> => {
    if (abandoned) return 'error';
    if (holding) return finish();
    let client: AsideAuth;
    try {
      client = aside ??= createAsideAuth();
      const { data, error } = await client.verifyOtp({ email: address, token: code, type: kind });
      if (error) {
        if (isRateLimited(error)) return 'rate_limited';
        if (isOffline(error)) return 'offline';
        return codeOf(error).code === 'otp_expired' ? 'wrong_code' : 'error';
      }
      if (!data.session) return 'error';
    } catch {
      return 'error';
    }
    if (abandoned) {
      // Left while the code was being checked: the address is confirmed by now, so the session it
      // signed in goes the way an abandoned one does.
      await leave(client);
      return 'error';
    }
    holding = true;
    return finish();
  };

  const abandon = async () => {
    abandoned = true;
    const client = holding ? aside : null;
    holding = false;
    if (client !== null) await leave(client);
  };

  return { verify, finish, abandon };
}

/** Auth's answer to a request for a mail, read the same way for a sign-up code and a reset code. */
const mailAnswer = (error: unknown): ResendResult => {
  if (!error) return 'sent';
  if (isTooSoon(error)) return 'too_soon';
  if (isRateLimited(error)) return 'rate_limited';
  return isOffline(error) ? 'offline' : 'error';
};

/**
 * Mails a fresh sign-up code to an address not yet confirmed; the one sent before stops working.
 * Auth answers an address it doesn't know, or one already confirmed, the same as a sent mail.
 */
export async function resendEmailCode(email: string): Promise<ResendResult> {
  try {
    const { error } = await supabase.auth.resend({ type: 'signup', email: normalise(email) });
    return mailAnswer(error);
  } catch {
    return 'error';
  }
}

/**
 * Forgot password: mails a reset code to the address when it has an account; the one sent before
 * stops working. Auth answers an address it doesn't know the same as a sent mail, so nobody learns
 * from this which addresses have accounts.
 */
export async function requestPasswordReset(email: string): Promise<ResendResult> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(normalise(email));
    return mailAnswer(error);
  } catch {
    return 'error';
  }
}
