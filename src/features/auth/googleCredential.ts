/**
 * Sign in with Google on Android: the `GoogleCredential` native module (modules/google-credential),
 * Credential Manager's account sheet. It answers with a Google ID token for the web client id with
 * the given nonce in it. The lookup is optional, so a binary without the module (or the iPhone,
 * where it does not exist) gets null and the Google button stays unarmed instead of crashing.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

/** Backing out of the sheet (GoogleCredentialErrors.CANCELLED in the Kotlin module). */
export const GOOGLE_CREDENTIAL_CANCELLED = 'ERR_GOOGLE_CREDENTIAL_CANCELLED';

export interface GoogleCredentialNative {
  /** The Google ID token for `serverClientId` (the web client id), carrying `nonce` as given. */
  signInAsync(serverClientId: string, nonce: string): Promise<string>;
}

export function googleCredentialModule(): GoogleCredentialNative | null {
  try {
    return requireOptionalNativeModule<GoogleCredentialNative>('GoogleCredential');
  } catch {
    return null;
  }
}
