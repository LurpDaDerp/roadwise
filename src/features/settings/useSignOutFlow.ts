import { useState } from 'react';
import { Alert } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { homeCopy } from '@/features/home/copy';

/**
 * Asks before a sign-out acts, only when the flush left deletes unsent: Home's own question and
 * words (`homeCopy.signOutCheck`), so the two ways out of the account ask the same thing.
 */
export function confirmUnsentSignOut(message: string): Promise<boolean> {
  const c = homeCopy.signOutCheck;
  return new Promise((resolve) => {
    Alert.alert(
      c.title,
      message,
      [
        { text: c.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: c.confirm, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

/**
 * The existing sign-out (security review D1 M-1): the session sends every delete this device owes
 * first and ends nothing if one could not be sent; the driver is told how many and decides. The auth
 * event, not this promise, moves the app to the signed-out screens.
 */
export function useSignOutFlow(confirm: (message: string) => Promise<boolean> = confirmUnsentSignOut) {
  const { signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const run = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const outcome = await signOut();
      if (outcome.signedOut) return;
      const c = homeCopy.signOutCheck;
      const message = outcome.unsentDeletes === null ? c.unknown : c.unsentDeletes(outcome.unsentDeletes);
      if (await confirm(message)) await signOut({ force: true });
    } catch {
      // Supabase ends the local session even when the revoke request fails.
    } finally {
      setSigningOut(false);
    }
  };
  return { signOut: run, signingOut };
}
