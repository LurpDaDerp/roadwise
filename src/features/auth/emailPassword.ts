import { callRpc } from '@/data/server/rpc';
import { supabase } from '@/data/supabase/client';

import { createAsideAuth, type AsideAuth } from './asideAuth';

/** The shortest password; the server's `minimum_password_length` (supabase/config.toml) says the same. */
export const PASSWORD_MIN = 8;

/** Digits in the code the confirmation mail carries: the server's `otp_length` (supabase/config.toml). */
export const CODE_LENGTH = 6;

/**
 * Seconds before Resend code can send another mail: the server's `max_frequency` in production
 * (supabase/config.toml), which refuses a second mail to one address sooner.
 */
export const RESEND_COOLDOWN_S = 60;

export type RegisterResult = 'ok' | 'confirm_email' | 'exists' | 'weak_password' | 'rate_limited' | 'error';
export type SignInResult = 'ok' | 'invalid' | 'unconfirmed' | 'rate_limited' | 'error';
/** `unfinished`: the code was right, but the account could not be made the driver's yet (Try again). */
export type VerifyResult = 'ok' | 'wrong_code' | 'rate_limited' | 'offline' | 'unfinished' | 'error';
export type ResendResult = 'sent' | 'rate_limited' | 'offline' | 'error';

const codeOf = (error: unknown): { status?: unknown; code?: unknown; name?: unknown } =>
  typeof error === 'object' && error !== null ? (error as { status?: unknown; code?: unknown; name?: unknown }) : {};

/** Auth refuses a burst of attempts with HTTP 429 (`over_request_rate_limit`, `over_email_send_rate_limit`). */
const isRateLimited = (error: unknown): boolean => {
  const { status, code } = codeOf(error);
  return status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit';
};

/** A request that never reached Auth: supabase-js answers it with a retryable fetch error, status 0. */
const isOffline = (error: unknown): boolean => {
  const { status, name } = codeOf(error);
  return name === 'AuthRetryableFetchError' && status === 0;
};

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Creates the account. With email confirmations on (supabase/config.toml) the answer carries no
 * session and Auth mails a 6-digit code to the address: `confirm_email`, and the code screen takes
 * it from there. An address that already has a confirmed account gets the same quiet answer from
 * Auth, but with a stand-in user that has no identities and no mail sent, so it reads as `exists`.
 * An answer with a session (a project with confirmations off) is `ok`: the driver is in at once.
 */
export async function registerWithPassword(email: string, password: string): Promise<RegisterResult> {
  const { data, error } = await supabase.auth.signUp({ email: normalise(email), password });
  if (error) {
    const { code } = codeOf(error);
    if (isRateLimited(error)) return 'rate_limited';
    if (code === 'user_already_exists' || code === 'email_exists') return 'exists';
    if (code === 'weak_password') return 'weak_password';
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
  const { error } = await supabase.auth.signInWithPassword({ email: normalise(email), password });
  if (!error) return 'ok';
  if (isRateLimited(error)) return 'rate_limited';
  const { code } = codeOf(error);
  if (code === 'email_not_confirmed') return 'unconfirmed';
  return code === 'invalid_credentials' ? 'invalid' : 'error';
}

/** One address's confirmation, from the code screen: see `startEmailConfirmation`. */
export type EmailConfirmation = {
  /** Checks the code from the mail and, when it is right, finishes the account and signs in. */
  verify: (code: string) => Promise<VerifyResult>;
  /** Finishes again after `unfinished` (the code is spent by then). */
  finish: () => Promise<VerifyResult>;
  /** The driver left the code screen: a confirmed session not yet handed over is signed out. */
  abandon: () => Promise<void>;
};

/**
 * Confirms an address with the code from its mail, failing closed. Auth keeps the password of the
 * first sign-up to an address until the address is confirmed (a second sign-up neither replaces it
 * nor is refused: Auth just mails a new code), so an account someone else registered to the
 * driver's address, and could never confirm, would otherwise come out of the driver's code
 * carrying that person's password. So the session the right code signs in stays on an aside client
 * (`createAsideAuth`), out of the app's sight, until:
 * 1. after a sign-up, the password chosen on the form is the account's (`updateUser`; Auth's
 *    `same_password` refusal, the usual answer, means it already is; a change also signs out
 *    every other session);
 * 2. every other session of the account is signed out;
 * 3. the app's client takes the session over (`setSession`), which signs the driver in.
 * Any of those failing is `unfinished`: the driver is not signed in, and `finish` tries again with
 * the same session. A sign-in to an unconfirmed account (`chosenPassword` null) skips step 1: its
 * password was just typed right. Auth answers a wrong code and an expired one alike
 * (`otp_expired`), so both are `wrong_code`.
 */
export function startEmailConfirmation(email: string, chosenPassword: string | null): EmailConfirmation {
  const address = normalise(email);
  let aside: AsideAuth | null = null;
  let held: { access_token: string; refresh_token: string } | null = null;

  const finish = async (): Promise<VerifyResult> => {
    if (aside === null || held === null) return 'error';
    try {
      if (chosenPassword !== null) {
        const { error } = await aside.updateUser({ password: chosenPassword });
        if (error && codeOf(error).code !== 'same_password') return 'unfinished';
      }
      const { error: othersError } = await aside.signOut({ scope: 'others' });
      if (othersError) return 'unfinished';
      const { error: handoverError } = await supabase.auth.setSession(held);
      if (handoverError) return 'unfinished';
    } catch {
      return 'unfinished';
    }
    // The app's client owns the session now; the aside one must never use it again.
    aside = null;
    held = null;
    return 'ok';
  };

  const verify = async (code: string): Promise<VerifyResult> => {
    if (held !== null) return finish();
    try {
      aside ??= createAsideAuth();
      const { data, error } = await aside.verifyOtp({ email: address, token: code, type: 'signup' });
      if (error) {
        if (isRateLimited(error)) return 'rate_limited';
        if (isOffline(error)) return 'offline';
        return codeOf(error).code === 'otp_expired' ? 'wrong_code' : 'error';
      }
      if (!data.session) return 'error';
      held = { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
    } catch {
      return 'error';
    }
    return finish();
  };

  const abandon = async () => {
    const left = held === null ? null : aside;
    aside = null;
    held = null;
    if (left === null) return;
    try {
      await left.signOut({ scope: 'local' });
    } catch {
      // Gone with the screen either way: nothing on the phone holds it.
    }
  };

  return { verify, finish, abandon };
}

/**
 * Mails a fresh code to an address not yet confirmed; the one sent before stops working. Auth
 * answers an address it doesn't know, or one already confirmed, the same as a sent mail.
 */
export async function resendEmailCode(email: string): Promise<ResendResult> {
  try {
    const { error } = await supabase.auth.resend({ type: 'signup', email: normalise(email) });
    if (!error) return 'sent';
    if (isRateLimited(error)) return 'rate_limited';
    return isOffline(error) ? 'offline' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * Takes the username chosen on the registration form, right after the account exists. A name that
 * was taken in the meantime is not an error here: the account has no username yet, so setup asks
 * for one, exactly as it does after Apple or Google.
 */
export async function claimChosenUsername(username: string): Promise<boolean> {
  try {
    await callRpc<null>('claim_username', { p: username });
    return true;
  } catch {
    return false;
  }
}
