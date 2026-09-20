import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { supabase } from '@/data/supabase/client';
import { env } from '@/lib/env';

WebBrowser.maybeCompleteAuthSession();

export function useGoogleSignIn(): { signIn: () => Promise<void>; ready: boolean } {
  const platformClientId = Platform.select({
    ios: env.googleIosClientId,
    android: env.googleAndroidClientId,
    default: env.googleWebClientId,
  });
  const configured = !!platformClientId;

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    // expo-auth-session throws an invariant when this platform's client id is `undefined`, which
    // would take the whole sign-in screen down on a build where Google is not configured yet. An
    // empty string clears the invariant; `ready` stays false, so the button is never armed.
    clientId: platformClientId ?? '',
    webClientId: env.googleWebClientId,
    iosClientId: env.googleIosClientId,
    androidClientId: env.googleAndroidClientId,
  });

  useEffect(() => {
    if (response?.type !== 'success') return;
    // On a native build the prompt comes back with an authorisation code, which the provider hook
    // exchanges for the id token before it lands here — so the exchange has to watch `response`
    // rather than the value `promptAsync` resolved with.
    const idToken = response.params.id_token;
    if (!idToken) return;
    void supabase.auth
      .signInWithIdToken({ provider: 'google', token: idToken })
      .then(({ error }) => {
        if (error) console.warn('Google sign-in could not be exchanged for a session', error);
      });
  }, [response]);

  async function signIn(): Promise<void> {
    if (!request) return;
    const result = await promptAsync();
    // A dismissed sheet is not a failure; a broken request is.
    if (result.type === 'error') throw result.error ?? new Error('Google sign-in failed');
  }

  return { signIn, ready: configured && !!request };
}
