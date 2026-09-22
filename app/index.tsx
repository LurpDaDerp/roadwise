import { Redirect, type Href } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { driveFacts, profileGate, resolveStart } from '@/features/auth/authGuard';
import { useUpdateStatus } from '@/features/auth/version';
import { t } from '@/i18n';
import { Banner, Button, Screen, Skeleton, Text } from '@/ui';

export const launchCopy = {
  loading: 'RoadWise loading',
  failed: "We couldn't load your profile",
  // True whatever the cause: there is no cached profile, and one read has to succeed first.
  failedBody: 'RoadWise needs to read your profile once before it can open offline.',
} as const;

/** How long the held frame waits for a profile before it offers the retry. */
export const PROFILE_WAIT_MS = 10_000;

/**
 * A1: the launch router. It draws a held frame, never a screen, and then hands off:
 * - an open trip (recording or ending) goes straight back to its drive screen, before any other
 *   rule (rev1: I2, N-m3; a candidate may be a bus ride, and finalizing is already over);
 * - then `resolveStart`: a required update, Welcome, not-eligible, onboarding, or Home.
 * A signed-in driver whose profile cannot be read and is not cached (a first launch offline) gets
 * the retry after 10 s; a cached profile lands them as usual (rev1: I11).
 */
export default function Launch() {
  const { status, profile, refreshProfile } = useSession();
  const host = useDriveHost();
  const snapshot = useDrive((s) => ({ status: s.status, mode: s.mode }));
  const update = useUpdateStatus();
  const gate = profileGate(profile);
  const to = resolveStart(status, gate, update, driveFacts(snapshot, host.isBusy()));

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

  // A skeleton field, not a spinner: the shape of the licence is already on screen when the first
  // real screen arrives.
  return (
    <Screen>
      <View accessible accessibilityLabel={launchCopy.loading}>
        <Skeleton width={160} height={24} />
      </View>
    </Screen>
  );
}
