import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import * as AppleAuthentication from 'expo-apple-authentication';
import { getRandomBytes } from 'expo-crypto';
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
