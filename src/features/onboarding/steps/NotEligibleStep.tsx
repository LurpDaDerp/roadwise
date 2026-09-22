import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { DriveContext } from '@/drive/DriveProvider';
import { Text, useTheme } from '@/ui';

import { markBlockPurged, purgeLocalDriveData, purgeOwnObjects, readBlockPurged } from '../api';
import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, StepPositionProvider } from '../StepFrame';

const copy = onboardingCopy.notEligible;

/**
 * `failed-local`: something on this phone could not be removed (the server part was not tried).
 * `failed-server`: the phone is clean; some objects in Storage are left for the server to remove.
 */
type Removal = 'running' | 'done' | 'failed-local' | 'failed-server';

/**
 * The under-13 block.
 *
 * By the time this renders the server has already minimised the account (0006, fired by the band
 * change): its drives, consents and devices are gone and it refuses new writes. What the server
 * cannot reach is removed from here, as the account itself:
 *   1. an open drive is left to close first (never deleting rows under the recorder);
 *   2. the child's drives on this phone — trips, events, samples, the sync queue with its
 *      `age_pending`-deferred uploads, the cached days and tiles, and the trace files;
 *   3. the account's own objects in Storage (`purgeOwnObjects`).
 * "We've kept only what we need to remember this." is printed only once all of that has
 * succeeded (rev1: I5); a failure says so and offers to try again.
 *
 * No "Step n of total": this is not a step on the way anywhere (T11 review). The one action is
 * the existing sign-out.
 */
export function NotEligibleStep(_props: StepProps) {
  const th = useTheme();
  const db = useDb();
  const { session, signOut } = useSession();
  const host = useContext(DriveContext)?.host ?? null;
  // Identity for every server call is the verified session's, never the profile row (security M-2).
  const userId = session?.user.id ?? null;
  const [removal, setRemoval] = useState<Removal>('running');
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Everything the server cannot remove itself; the outcome lands only when it is known. */
  const runRemoval = useCallback(async () => {
    // With no session nothing can be removed from Storage as this account: say so, never "done".
    let outcome: Removal = 'failed-local';
    try {
      // Finished before on this phone (review m1): nothing to redo, and no Storage listing.
      if (userId !== null && (await readBlockPurged(db, userId))) {
        outcome = 'done';
      } else {
        await host?.untilIdle();
        await purgeLocalDriveData(db);
        outcome = 'failed-server';
        if (userId !== null && (await purgeOwnObjects(userId)) === 'done') {
          await markBlockPurged(db, userId);
          outcome = 'done';
        }
      }
    } catch {
      // `outcome` says how far it got.
    }
    if (mounted.current) setRemoval(outcome);
  }, [userId, host, db]);

  const retry = () => {
    setRemoval('running');
    void runRemoval();
  };

  useEffect(() => {
    void runRemoval();
  }, [runRemoval]);

  const onSignOut = async () => {
    if (signingOut || removal === 'running') return;
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      const outcome = await signOut();
      // A delete this phone still owed is for a drive the server has already removed with the
      // rest of the account, so there is nothing left to wait for: sign out regardless.
      if (!outcome.signedOut) await signOut({ force: true });
    } catch {
      if (mounted.current) setSignOutFailed(true);
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  };

  const failed = removal === 'failed-local' || removal === 'failed-server';
  const tryAgain = { label: copy.retry, onPress: retry, testID: 'not-eligible-retry' };
  const signOutAction = {
    label: copy.signOut,
    onPress: () => void onSignOut(),
    // Not while the removal runs: signing out ends the session the Storage removal needs.
    disabled: removal === 'running',
    loading: signingOut,
    testID: 'not-eligible-sign-out',
  };

  return (
    <StepPositionProvider value={null}>
      <StepFrame
        title={copy.title}
        testID="not-eligible"
        // After a failure, trying again comes first; signing out stays possible, second.
        primary={failed ? tryAgain : signOutAction}
        secondary={failed ? signOutAction : undefined}
      >
        <View style={{ gap: th.space.md }} accessibilityLiveRegion="polite">
          {removal === 'running' ? (
            <Text variant="body" tone="muted" testID="not-eligible-removing">
              {copy.removing}
            </Text>
          ) : removal === 'done' ? (
            <Text variant="body" testID="not-eligible-kept">
              {copy.kept}
            </Text>
          ) : (
            <>
              <Text variant="body" tone="danger" accessibilityRole="alert">
                {copy.removeFailed}
              </Text>
              <Text variant="callout" tone="muted" testID="not-eligible-after-failure">
                {removal === 'failed-server' ? copy.serverFinishes : copy.stillOnPhone}
              </Text>
            </>
          )}
          {signOutFailed ? (
            <Text variant="callout" tone="danger" accessibilityRole="alert">
              {copy.signOutFailed}
            </Text>
          ) : null}
        </View>
      </StepFrame>
    </StepPositionProvider>
  );
}
