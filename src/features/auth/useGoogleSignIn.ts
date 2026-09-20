import { exchangeCodeAsync } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
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

  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    // expo-auth-session throws an invariant when this platform's client id is `undefined`, which
    // would take the whole sign-in screen down on a build where Google is not configured yet. An
    // empty string clears the invariant; `ready` stays false, so the button is never armed.
    clientId: platformClientId ?? '',
    webClientId: env.googleWebClientId,
    iosClientId: env.googleIosClientId,
    androidClientId: env.googleAndroidClientId,
    // The hook would otherwise trade the code for a token inside its own effect, where a failure
    // has nowhere to go and a second exchange of a spent code is a race away. `signIn` owns it.
    shouldAutoExchangeCode: false,
  });

  /** Google hands installed apps an authorisation code; the id token is one exchange further on. */
  async function idTokenFrom(params: Record<string, string>): Promise<string> {
    if (params.id_token) return params.id_token;
    const code = params.code;
    if (!code || !request) throw new Error('Google returned no identity token');
    const token = await exchangeCodeAsync(
      {
        clientId: platformClientId ?? '',
        code,
        redirectUri: request.redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? '' },
      },
      Google.discovery
    );
    if (!token.idToken) throw new Error('Google returned no identity token');
    return token.idToken;
  }

  /**
   * The whole flow, awaited: prompt, exchange, session. Handing any of it to an effect would leave
   * the screen with nothing to show when Google or Supabase says no — the caller has to be able to
   * see the failure it is about to render.
   */
  async function signIn(): Promise<void> {
    if (!request) return;
    const result = await promptAsync();
    if (result.type === 'error') throw result.error ?? new Error('Google sign-in failed');
    // Backing out of the Google sheet must leave the screen exactly as it was, with no error.
    if (result.type !== 'success') return;

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: await idTokenFrom(result.params),
    });
    if (error) throw error;
  }

  return { signIn, ready: configured && !!request };
}
