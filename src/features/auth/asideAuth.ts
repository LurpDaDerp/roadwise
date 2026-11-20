import { createClient } from '@supabase/supabase-js';

import { env } from '@/lib/env';

/**
 * An Auth client of its own for confirming an address: its session lives in memory only, is never
 * refreshed and is never seen by the app's session listener. The session a confirmation code
 * signs in lands here first, and the app's client takes it over (`setSession`) only once the
 * account is the driver's (`emailPassword.ts`).
 */
export function createAsideAuth() {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'roadwise-email-confirmation',
    },
  }).auth;
}

export type AsideAuth = ReturnType<typeof createAsideAuth>;
