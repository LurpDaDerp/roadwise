import 'react-native-get-random-values';

import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { env } from '@/lib/env';

import { LargeSecureStore } from './largeSecureStore';
import type { Database } from './types';

export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: new LargeSecureStore(),
    autoRefreshToken: true,
    persistSession: true,
    // Native has no URL bar for Supabase to read a session out of; deep links are handled explicitly.
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

// Refresh tokens only while the app is in the foreground: a background timer fires on a suspended
// JS thread and burns battery for nothing.
//
// auth-js cannot see focus in React Native, so it starts its 30 s refresh ticker by itself once
// the client has initialised, whatever AppState says, and a `change` listener alone only catches
// up at the next transition. A launch that begins in the background — an iOS location wake, a
// relaunch mid-drive, the Android headless drive — gets no such transition, so the ticker ran for
// that process's whole life: a keychain read and an AES decrypt of the stored session every 30 s,
// and a refresh request as soon as the token neared expiry, through a drive nobody was looking at
// (design §3.5). So once initialisation is over the ticker is stopped unless the app is active by
// then, and the listener starts it again on the next `active`.
function followAppState(state: string | null | undefined): void {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh().catch(() => {});
  } else {
    void supabase.auth.stopAutoRefresh().catch(() => {});
  }
}

AppState.addEventListener('change', followAppState);

// `getSession()` settles only after the client's own initialisation — which is what starts the
// ticker — so this is the first moment a stop is not simply overtaken by that start. An app that
// is active by then keeps the ticker auth-js started; anything else stops it. A read that rejects
// (an unreadable stored session) has initialised all the same, and its ticker would only fail the
// same way every 30 s.
const initialised = (): void => {
  if (AppState.currentState !== 'active') followAppState(AppState.currentState);
};
void supabase.auth.getSession().then(initialised, initialised);
