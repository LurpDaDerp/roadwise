import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { exchangeCodeAsync } from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import { getRandomBytes } from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Platform } from 'react-native';

import { supabase } from '@/data/supabase/client';
import { env } from '@/lib/env';

import { GOOGLE_CREDENTIAL_CANCELLED, googleCredentialModule } from './googleCredential';

WebBrowser.maybeCompleteAuthSession();

export interface GoogleSignIn {
  signIn: () => Promise<void>;
  ready: boolean;
}

/**
 * Sign in with Google. The iPhone (and the web) goes through Google's own page in a browser sheet
 * (expo-auth-session); Android through Credential Manager's account sheet (`./googleCredential`),
 * which needs no redirect back into the app. Either way Supabase gets a Google ID token and the raw
 * nonce whose SHA-256 is inside it. The platform never changes while the app runs, so each build
 * always calls the same hooks.
 */
export const useGoogleSignIn: () => GoogleSignIn = Platform.OS === 'android' ? useGoogleSignInAndroid : useGoogleSignInAuthSession;

/** The iPhone's (and the web's) Google sign-in: expo-auth-session's id-token request. */
export function useGoogleSignInAuthSession(): GoogleSignIn {
  const platformClientId = Platform.select({
    ios: env.googleIosClientId,
    android: env.googleAndroidClientId,
    default: env.googleWebClientId,
  });
  const configured = !!platformClientId;

  // A fresh nonce per sign-in screen: Google bakes its SHA-256 into the id token and Supabase checks
  // the raw value against it, so a token lifted from another sign-in cannot be replayed here.
  const [nonce] = useState(() => {
    const raw = bytesToHex(getRandomBytes(32));
    return { raw, hashed: bytesToHex(sha256(utf8ToBytes(raw))) };
  });

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
    extraParams: { nonce: nonce.hashed },
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
    // Backing out of the Google sheet must leave the screen exactly as it was, with no error. Cancel
    // on Google's own page comes back as an error too (access_denied), as Apple's does.
    if (result.type === 'error') {
      if (result.error?.code === 'access_denied' || result.params?.error === 'access_denied') return;
      throw result.error ?? new Error('Google sign-in failed');
    }
    if (result.type !== 'success') return;

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: await idTokenFrom(result.params),
      nonce: nonce.raw,
    });
    if (error) throw error;
  }

  return { signIn, ready: configured && !!request };
}

/**
 * Android's Google sign-in: Credential Manager's "Sign in with Google" sheet for the web client id.
 * Google checks the app's package and signing certificate against the project's Android OAuth
 * clients itself, so the app carries no Android client id. A fresh nonce per sign-in: the sheet
 * gets its SHA-256, Supabase the raw value. Backing out of the sheet leaves the screen as it was.
 */
export function useGoogleSignInAndroid(): GoogleSignIn {
  const [native] = useState(googleCredentialModule);
  const clientId = env.googleWebClientId;

  async function signIn(): Promise<void> {
    if (!native || !clientId) return;
    const raw = bytesToHex(getRandomBytes(32));
    let idToken: string;
    try {
      idToken = await native.signInAsync(clientId, bytesToHex(sha256(utf8ToBytes(raw))));
    } catch (e) {
      if ((e as { code?: string }).code === GOOGLE_CREDENTIAL_CANCELLED) return;
      throw e;
    }
    if (!idToken) throw new Error('Google returned no identity token');
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce: raw });
    if (error) throw error;
  }

  return { signIn, ready: native !== null && !!clientId };
}
