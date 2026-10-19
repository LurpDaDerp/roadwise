import { callRpc } from '@/data/server/rpc';
import { supabase } from '@/data/supabase/client';

/** The shortest password; the server's `minimum_password_length` (supabase/config.toml) says the same. */
export const PASSWORD_MIN = 8;

export type RegisterResult = 'ok' | 'confirm_email' | 'exists' | 'weak_password' | 'rate_limited' | 'error';
export type SignInResult = 'ok' | 'invalid' | 'rate_limited' | 'error';

const codeOf = (error: unknown): { status?: unknown; code?: unknown } =>
  typeof error === 'object' && error !== null ? (error as { status?: unknown; code?: unknown }) : {};

/** Auth refuses a burst of attempts with HTTP 429 (`over_request_rate_limit`, `over_email_send_rate_limit`). */
const isRateLimited = (error: unknown): boolean => {
  const { status, code } = codeOf(error);
  return status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit';
};

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Creates the account. With email confirmations off (supabase/config.toml) the answer carries a
 * session, so the driver is in at once and `AuthGate` takes it from there; `confirm_email` is the
 * answer from a project that has confirmations switched on.
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
  return data.session ? 'ok' : 'confirm_email';
}

/** Email and password for an account that exists. A wrong email and a wrong password read the same. */
export async function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  const { error } = await supabase.auth.signInWithPassword({ email: normalise(email), password });
  if (!error) return 'ok';
  if (isRateLimited(error)) return 'rate_limited';
  return codeOf(error).code === 'invalid_credentials' ? 'invalid' : 'error';
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
