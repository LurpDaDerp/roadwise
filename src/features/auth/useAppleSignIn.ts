import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import * as AppleAuthentication from 'expo-apple-authentication';
import { getRandomBytes } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { supabase } from '@/data/supabase/client';

/** Apple returns `ERR_REQUEST_CANCELED` when the sheet is dismissed; that is not a failure. */
const CANCELLED = 'ERR_REQUEST_CANCELED';

/**
 * Where Apple's web sign-in on Android comes back to (through Supabase): the app's own scheme. It
 * must be in the hosted project's redirect allow-list (supabase/config.toml), and `+native-intent`
 * leaves it alone so the sign-in screen stays put while the session is made.
 */
export const APPLE_WEB_REDIRECT = 'roadwise://auth-callback';

/**
 * The parameters of the link the sign-in came back on: its query and its fragment (Supabase puts an
 * error in either). Read by hand: React Native's URL has no reliable `searchParams`.
 */
export function callbackParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const at = url.search(/[?#]/);
  if (at < 0) return out;
  for (const pair of url.slice(at + 1).split(/[&#?]/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      // a malformed escape: that pair is skipped
    }
  }
  return out;
}

/** Whether this build offers Apple's web sign-in on Android (EXPO_PUBLIC_APPLE_WEB_SIGNIN=1). */
function appleWebSignIn(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the build's env, read only on Android
    return (require('@/lib/env') as typeof import('@/lib/env')).env.appleWebSignIn;
  } catch {
    return false;
  }
}

/**
 * Sign in with Apple on Android: Supabase's Apple web sign-in (the Services ID) in a Custom Tab,
 * back to the app with a one-time code that Supabase trades for the session (PKCE: the verifier
 * never left the phone). An Apple ID that signed in on an iPhone lands on the same account (the
 * Services ID is grouped with the app's App ID, so Apple gives both the same user id). Backing out
 * leaves the screen as it was. Apple's web sheet may offer to share a name, which the app never asks
 * for: if one comes, it is cleared from the account at once, so drivers still go by usernames only.
 */
async function signInWithAppleWeb(): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: APPLE_WEB_REDIRECT, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('Supabase returned no Apple sign-in page');
  const result = await WebBrowser.openAuthSessionAsync(data.url, APPLE_WEB_REDIRECT);
  // closed, or the app was brought back without an answer: nothing happened
  if (result.type !== 'success') return;
  const params = callbackParams(result.url);
  const code = params.code;
  if (!code) {
    // Apple's "Cancel" comes back as an error too: no failure to show for it
    if (params.error === 'access_denied' || params.error_code === 'user_cancelled_authorize') return;
    throw new Error(`Apple sign-in failed: ${params.error_code ?? params.error ?? 'no code'}`);
  }
  const exchanged = await supabase.auth.exchangeCodeForSession(code);
  if (exchanged.error) throw exchanged.error;
  const meta = exchanged.data.user?.user_metadata as Record<string, unknown> | undefined;
  if (meta && (meta.full_name || meta.name)) {
    // best effort: the session stands either way
    await supabase.auth.updateUser({ data: { full_name: null, name: null } }).catch(() => {});
  }
}

export function useAppleSignIn(): { signIn: () => Promise<void>; available: boolean } {
  const [available, setAvailable] = useState(() => Platform.OS === 'android' && appleWebSignIn());

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let live = true;
    void AppleAuthentication.isAvailableAsync().then((ok) => {
      if (live) setAvailable(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  async function signIn(): Promise<void> {
    if (Platform.OS === 'android') return signInWithAppleWeb();
    // A fresh nonce per sign-in: Apple bakes its SHA-256 into the identity token and Supabase checks
    // the raw value against it, so a token lifted from another sign-in cannot be replayed here.
    const rawNonce = bytesToHex(getRandomBytes(32));
    const hashedNonce = bytesToHex(sha256(utf8ToBytes(rawNonce)));
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        // Email only: drivers go by usernames, so the real name is never asked for or stored.
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
        nonce: hashedNonce,
      });
    } catch (e) {
      // Backing out of the Apple sheet must leave the screen exactly as it was, with no error.
      if ((e as { code?: string }).code === CANCELLED) return;
      throw e;
    }
    if (!credential.identityToken) throw new Error('Apple returned no identity token');

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) throw error;
  }

  return { signIn, available };
}
