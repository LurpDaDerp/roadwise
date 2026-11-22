import 'react-native-get-random-values';

import { createClient, type Session } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { env } from '@/lib/env';

import { boundedFetch } from './boundedFetch';
import { LargeSecureStore } from './largeSecureStore';
import type { Database } from './types';

const storage = new LargeSecureStore();

export const supabase = createClient<Database>(env.supabaseUrl, env.supabasePublishableKey, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    // Native has no URL bar for Supabase to read a session out of; deep links are handled explicitly.
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
  // No request waits forever for an answer (Android has no network time-out of its own).
  global: { fetch: boundedFetch() },
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The session auth-js keeps on the phone, read straight from its storage under the client's own
 * key: no refresh, no network, no write. Null when none is stored or what is stored is not a whole
 * session (both tokens, an expiry and a user); never rejects.
 *
 * Offline with an expired access token, auth-js's own read (`getSession`) retries the refresh for
 * about 25 s and then answers no session with the refresh's error, though the session is still
 * stored and still good once the network is back. This is what stands in for it meanwhile
 * (`session.tsx`). Its expiry is not checked: an expired session that can still be refreshed is
 * exactly the one it is for.
 */
export async function readStoredSession(): Promise<Session | null> {
  try {
    const key = (supabase.auth as unknown as { storageKey?: unknown }).storageKey;
    if (typeof key !== 'string' || key.length === 0) return null;
    const raw = await storage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value.user)) return null;
    if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') return null;
    if (typeof value.expires_at !== 'number') return null;
    if (typeof value.user.id !== 'string' || value.user.id.length === 0) return null;
    return value as unknown as Session;
  } catch {
    return null;
  }
}

// Refresh tokens only while the app is in the foreground: a background timer fires on a suspended
// JS thread and burns battery for nothing.
//
// auth-js cannot see focus in React Native, so it starts its 30 s refresh ticker by itself once
// the client has initialised, whatever AppState says, and a `change` listener alone only catches
// up at the next transition. A launch that begins in the background — an iOS Bluetooth relaunch, a
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
