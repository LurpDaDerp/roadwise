import { Redirect, type Href } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { driveFacts, profileGate, resolveStart } from '@/features/auth/authGuard';
import { useUpdateStatus } from '@/features/auth/version';
import { driveScreenEnteredFor, subscribeDriveScreen } from '@/features/drive/hudPresence';
import { t } from '@/i18n';
import { Banner, Button, Screen, Skeleton, Text } from '@/ui';

export const launchCopy = {
  loading: 'Loading RoadWise',
  failed: "We couldn't load your profile",
  // True whatever the cause: there is no cached profile, and one read has to succeed first.
  failedBody: 'RoadWise needs to load your profile once before it can work offline.',
} as const;

/** How long the held frame waits for a profile before it offers the retry. */
export const PROFILE_WAIT_MS = 10_000;

/**
 * A1: the launch router. It draws a held frame, never a screen, and then hands off:
 * - an open manual trip (recording or ending), or an automatic one whose driving screen was shown
 *   during it, goes straight back to the driving screen, before any other rule;
 * - then `resolveStart`: a required update, sign-in, onboarding, or Home (an automatic drive never
 *   opened included: Home's Drive in progress strip leads to its driving screen).
 * A signed-in driver whose profile cannot be read and is not cached (a first launch offline) gets
 * the retry after 10 s; a cached profile lands them as usual (rev1: I11).
 */
export default function Launch() {
  const { status, profile, refreshProfile } = useSession();
  const host = useDriveHost();
  const drive = useDrive((s) => ({ status: s.status, origin: s.origin, tripId: s.clientTripId }));
  const entered = useSyncExternalStore(subscribeDriveScreen, () => driveScreenEnteredFor(drive.tripId));
  const update = useUpdateStatus();
  const gate = profileGate(profile);
  const to = resolveStart(status, gate, update, driveFacts(drive, host.isBusy(), entered));

  const [waited, setWaited] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const announced = useRef(false);

  // Held: said once, so a screen reader is not left in silence on a blank frame.
  useEffect(() => {
    if (to !== null || announced.current) return;
    announced.current = true;
    AccessibilityInfo.announceForAccessibility(launchCopy.loading);
  }, [to]);

  // One bounded wait on a foreground launch, cleared the moment the launch lands.
  useEffect(() => {
    if (to !== null) return;
    const timer = setTimeout(() => setWaited(true), PROFILE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [to]);

  if (to) return <Redirect href={to as Href} />;

  if (waited && status === 'signedIn' && gate === 'unknown') {
    const retry = () => {
      setRetrying(true);
      refreshProfile()
        .catch(() => {
          // Still unreachable: the card stays, with its button back.
        })
        .finally(() => setRetrying(false));
    };
    return (
      <Screen>
        <Text variant="title2" accessibilityRole="header">
          {launchCopy.failed}
        </Text>
        <Banner tone="danger" message={launchCopy.failedBody} />
        <View style={{ flexGrow: 1 }} />
        <Button
          label={t('common.retry')}
          onPress={retry}
          loading={retrying}
          disabled={retrying}
          testID="launch-retry"
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View accessible accessibilityLabel={launchCopy.loading}>
        <Skeleton width={160} height={24} />
      </View>
    </Screen>
  );
}
