import { useState } from 'react';
import { Alert } from 'react-native';

import { useSession } from '@/data/supabase/session';

export const signOutCheckCopy = {
  title: 'Sign out?',
  unsentDeletes: (n: number) =>
    n === 1
      ? "1 drive or report hasn't uploaded yet. If you sign out, it uploads next time you sign in on this phone."
      : `${n} drives or reports haven't uploaded yet. If you sign out, they upload next time you sign in on this phone.`,
  unknown:
    "We couldn't check if everything uploaded. Anything left uploads next time you sign in on this phone.",
  cancel: 'Cancel',
  confirm: 'Sign out',
  failedTitle: "Couldn't sign out",
  failed: "You're still signed in. Check your connection and try again.",
  ok: 'OK',
} as const;

/** Says a sign-out could not end the session (offline with an expired token): still signed in. */
export function notifySignOutFailed(): void {
  const c = signOutCheckCopy;
  Alert.alert(c.failedTitle, c.failed, [{ text: c.ok }]);
}

/** Asks before a sign-out acts, only when the flush left drive uploads or reports unsent. */
export function confirmUnsentSignOut(message: string): Promise<boolean> {
  const c = signOutCheckCopy;
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
export function useSignOutFlow(
  confirm: (message: string) => Promise<boolean> = confirmUnsentSignOut,
  notifyFailed: () => void = notifySignOutFailed
) {
  const { signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const run = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const outcome = await signOut();
      if (outcome.signedOut) return;
      if ('failed' in outcome) {
        notifyFailed();
        return;
      }
      const c = signOutCheckCopy;
      const message = outcome.unsentDeletes === null ? c.unknown : c.unsentDeletes(outcome.unsentDeletes);
      if (!(await confirm(message))) return;
      const forced = await signOut({ force: true });
      if (!forced.signedOut && 'failed' in forced) notifyFailed();
    } catch {
      // Supabase ends the local session even when the revoke request fails.
    } finally {
      setSigningOut(false);
    }
  };
  return { signOut: run, signingOut };
}
