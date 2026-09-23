import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { diagnosticsEnabled } from '@/features/dev/flags';
import { DriveInProgressBanner } from '@/features/drive/DriveInProgressBanner';
import {
  DetectionStatusLine,
  HomeBanners,
  homeCopy,
  LastTripCard,
  LicenceCard,
  WeeklyFocusField,
} from '@/features/home';
import { InboxBell } from '@/features/inbox/InboxBell';
import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

/** Typed routes are generated at `expo start`; these two land with U3 and U5. */
const DRIVE_START_HREF = '/drive/start' as Href;
const DIAGNOSTICS_HREF = '/dev/drive' as Href;

/**
 * The one place a sign-out asks before it acts. Today it asks only when the flush left deletes
 * unsent; an unconditional "Sign out?" (an open product question) is one more call to this.
 */
function confirmSignOut(message: string): Promise<boolean> {
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
 * B1 — Home (§7.B B1, direction contract FIRST VIEWPORT): the header with the inbox bell (B3,
 * Task 18), the status banners, the licence card (with M5's CLASS, STREAK, SAFE DAYS and POINTS),
 * the RECORD — the last drive and this week's focus — the detection status line, and the bottom-anchored Start drive that the tab
 * bar's centre Drive action mirrors. Sign-out sits at the foot of the page with its consequence.
 */
export default function Home() {
  const th = useTheme();
  const router = useRouter();
  const { signOut, profile } = useSession();
  const busy = useDrive((s) => isBusyStatus(s.status));
  const [signingOut, setSigningOut] = useState(false);

  // Security review D1 M-1: the session's sign-out first sends every delete this device owes,
  // while the session can still send them, and ends nothing if one could not be sent. Then the
  // driver is told how many, plainly, and decides.
  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const outcome = await signOut();
      if (outcome.signedOut) return;
      const c = homeCopy.signOutCheck;
      const message =
        outcome.unsentDeletes === null ? c.unknown : c.unsentDeletes(outcome.unsentDeletes);
      if (await confirmSignOut(message)) await signOut({ force: true });
    } catch {
      // Supabase ends the local session even when the revoke request fails; the auth event, not
      // this promise, moves the app to the signed-out screens.
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Screen bottomInset={false} padded={false}>
      {/* One column, so the scrolling record and the anchored action meet without a gap. */}
      <View style={{ flex: 1 }}>
        {/* The header: the inbox bell at the trailing edge, above the scrolling record, so it is
          always one tap away. It prints the unread count as a number, never as colour alone. */}
        <View
          testID="home-header"
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            paddingHorizontal: th.space.sm,
            paddingTop: th.space.xs,
          }}
        >
          <InboxBell />
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            padding: th.space.lg,
            gap: th.space.lg,
          }}
          showsVerticalScrollIndicator={false}
          testID="home"
        >
          <HomeBanners inProgress={<DriveInProgressBanner />} />
          <LicenceCard name={profile?.display_name} />
          <LastTripCard />
          <WeeklyFocusField />
          <DetectionStatusLine />
          <View style={{ flexGrow: 1 }} />
          {/* The consequence sits with the control, before the press rather than after it: the next
            sign-in by anyone else clears this phone, and an un-uploaded drive is nowhere else. */}
          <View style={{ gap: 4 }}>
            <Button
              label={t('home.signOut')}
              variant="ghost"
              onPress={() => void onSignOut()}
              loading={signingOut}
              accessibilityHint={homeCopy.signOutWarning}
            />
            <Text variant="footnote" tone="muted">
              {homeCopy.signOutWarning}
            </Text>
          </View>
          {/* The same guard as the route itself (U5), so the link never leads to a redirect. */}
          {diagnosticsEnabled() ? (
            <Button
              label={homeCopy.diagnostics}
              variant="ghost"
              size="md"
              onPress={() => router.push(DIAGNOSTICS_HREF)}
              testID="diagnostics-link"
            />
          ) : null}
        </ScrollView>
        {/* One bottom-anchored primary action. While a drive is running the in-progress banner at
          the top carries that drive's actions instead, so a second Start would only mislead. */}
        {busy ? null : (
          <View
            style={{
              paddingHorizontal: th.space.lg,
              paddingVertical: th.space.md,
              borderTopWidth: 1,
              borderTopColor: th.colors.divider,
              backgroundColor: th.colors.bg,
            }}
          >
            <Button
              label={homeCopy.startDrive}
              onPress={() => router.push(DRIVE_START_HREF)}
              accessibilityHint={homeCopy.startDriveHint}
              testID="start-drive"
            />
          </View>
        )}
      </View>
    </Screen>
  );
}
