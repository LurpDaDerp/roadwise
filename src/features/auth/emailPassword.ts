import { callRpc } from '@/data/server/rpc';
import { supabase } from '@/data/supabase/client';

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
export type VerifyResult = 'ok' | 'wrong_code' | 'rate_limited' | 'offline' | 'error';
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

/**
 * Checks the code from the confirmation mail. The right one confirms the address and signs the
 * driver in (Auth answers with a session, and the session listener takes it from there). Auth
 * answers a wrong code and an expired one alike (`otp_expired`), so both are `wrong_code`.
 */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyResult> {
  try {
    const { data, error } = await supabase.auth.verifyOtp({ email: normalise(email), token: code, type: 'signup' });
    if (!error) return data.session ? 'ok' : 'error';
    if (isRateLimited(error)) return 'rate_limited';
    if (isOffline(error)) return 'offline';
    const { code: reason } = codeOf(error);
    return reason === 'otp_expired' ? 'wrong_code' : 'error';
  } catch {
    return 'error';
  }
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
 * Sets the password the driver chose on the registration form, right after their code confirmed
 * the address. Auth keeps the password of the first sign-up for an address until it is confirmed,
 * so an account someone else registered to this address and could never confirm would otherwise
 * keep that person's password. Best effort: the usual answer, the same password as before, is a
 * refusal (`same_password`) and changes nothing, and any failure leaves the driver signed in.
 */
export async function keepChosenPassword(password: string): Promise<void> {
  try {
    await supabase.auth.updateUser({ password });
  } catch {
    // Nothing to tell the driver: they are signed in either way.
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
