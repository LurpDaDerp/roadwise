import { useState } from 'react';

import { supabase } from '@/data/supabase/client';

/** The deep link the emailed link comes back on; `app/auth/callback.tsx` answers it. */
export const AUTH_REDIRECT = 'roadwise://auth/callback';

export type MagicLinkState = 'idle' | 'sending' | 'sent' | 'rate_limited' | 'error';
export type MagicLinkResult = 'sent' | 'rate_limited' | 'error';

/**
 * Supabase Auth refuses a burst of sign-in emails with HTTP 429 (`over_email_send_rate_limit`).
 * That is not a broken sign-in, and the driver needs to hear "wait", not "try again".
 */
const isRateLimited = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 429 || code === 'over_email_send_rate_limit';
};

export function useMagicLink(): {
  send: (email: string) => Promise<MagicLinkResult>;
  state: MagicLinkState;
} {
  const [state, setState] = useState<MagicLinkState>('idle');

  async function send(email: string): Promise<MagicLinkResult> {
    setState('sending');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: AUTH_REDIRECT },
    });
    const next: MagicLinkResult = !error ? 'sent' : isRateLimited(error) ? 'rate_limited' : 'error';
    setState(next);
    return next;
  }

  return { send, state };
}
