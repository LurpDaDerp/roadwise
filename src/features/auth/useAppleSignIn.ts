import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { supabase } from '@/data/supabase/client';

/** Apple returns `ERR_REQUEST_CANCELED` when the sheet is dismissed; that is not a failure. */
const CANCELLED = 'ERR_REQUEST_CANCELED';

export function useAppleSignIn(): { signIn: () => Promise<void>; available: boolean } {
  const [available, setAvailable] = useState(false);

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
    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
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
    });
    if (error) throw error;

    // Apple hands over the name once, on the very first authorisation, and never again — so write
    // it through immediately rather than waiting for onboarding to ask for it.
    const name = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ');
    if (name) await supabase.auth.updateUser({ data: { display_name: name } });
  }

  return { signIn, available };
}
