import { useState } from 'react';

import { supabase } from '@/data/supabase/client';

/** The deep link the emailed link comes back on; `app/auth/callback.tsx` answers it. */
export const AUTH_REDIRECT = 'roadwise://auth/callback';

export type MagicLinkState = 'idle' | 'sending' | 'sent' | 'error';

export function useMagicLink(): {
  send: (email: string) => Promise<'sent' | 'error'>;
  state: MagicLinkState;
} {
  const [state, setState] = useState<MagicLinkState>('idle');

  async function send(email: string): Promise<'sent' | 'error'> {
    setState('sending');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: AUTH_REDIRECT },
    });
    const next = error ? 'error' : 'sent';
    setState(next);
    return next;
  }

  return { send, state };
}
