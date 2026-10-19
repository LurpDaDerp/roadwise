import { supabase } from '@/data/supabase/client';

/** Digits in the emailed code; the server's `otp_length` (supabase/config.toml) says the same. */
export const CODE_LENGTH = 6;

export type SendResult = 'sent' | 'rate_limited' | 'error';
export type VerifyResult = 'ok' | 'invalid' | 'rate_limited' | 'error';

/** Auth refuses a burst of sign-in emails (`over_email_send_rate_limit`) or tries (HTTP 429). */
const isRateLimited = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 429 || code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit';
};

/** A wrong, spent or expired code: Auth answers 403 `otp_expired` for all three. */
const isBadCode = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'otp_expired';

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Step one of email sign-in: Auth emails a 6-digit code, creating the account on a first sign-in.
 * No redirect is sent, so the email carries the code and no link (the email templates see to it).
 */
export async function sendEmailCode(email: string): Promise<SendResult> {
  const { error } = await supabase.auth.signInWithOtp({ email: normalise(email) });
  if (!error) return 'sent';
  return isRateLimited(error) ? 'rate_limited' : 'error';
}

/** Step two: the code from the email becomes a session; `AuthGate` takes it from there. */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyResult> {
  const { error } = await supabase.auth.verifyOtp({ email: normalise(email), token: code, type: 'email' });
  if (!error) return 'ok';
  if (isRateLimited(error)) return 'rate_limited';
  return isBadCode(error) ? 'invalid' : 'error';
}
