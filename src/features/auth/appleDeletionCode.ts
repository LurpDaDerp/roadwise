/**
 * Delete account, for an account signed in with Apple on an iPhone: a fresh Apple authorization
 * code the server exchanges and revokes (`supabase/functions/_shared/apple_siwa.ts`), so the Apple ID
 * stops listing RoadWise once the account is gone. Apple's sheet is the confirmation; backing out
 * of it stops the deletion. RoadWise keeps no Apple tokens, so this is the only time one is asked for.
 */
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

/** `code`: send it; `cancelled`: the driver backed out, delete nothing; `none`: delete without one. */
export type AppleDeletionCode = { kind: 'code'; code: string } | { kind: 'cancelled' } | { kind: 'none' };

/** Apple returns `ERR_REQUEST_CANCELED` when the sheet is dismissed. */
const CANCELLED = 'ERR_REQUEST_CANCELED';

/** The account's sign-in methods, from the session user's `app_metadata`. */
export function hasAppleSignIn(appMetadata: { provider?: unknown; providers?: unknown } | null | undefined): boolean {
  if (!appMetadata) return false;
  if (appMetadata.provider === 'apple') return true;
  return Array.isArray(appMetadata.providers) && appMetadata.providers.includes('apple');
}

/**
 * Shows Apple's sheet (no name, no email) and returns its authorization code. Off iOS, or when
 * Apple can't answer (no Apple ID on the phone, an Apple error), deletion goes ahead without one:
 * a revocation never stands in the way of deleting an account.
 */
export async function appleDeletionCode(): Promise<AppleDeletionCode> {
  if (Platform.OS !== 'ios') return { kind: 'none' };
  try {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode ? { kind: 'code', code: credential.authorizationCode } : { kind: 'none' };
  } catch (e) {
    if ((e as { code?: string }).code === CANCELLED) return { kind: 'cancelled' };
    return { kind: 'none' };
  }
}
