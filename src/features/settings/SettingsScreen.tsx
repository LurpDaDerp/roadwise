import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { useSession } from '@/data/supabase/session';
import { homeCopy } from '@/features/home/copy';
import { useRewards } from '@/features/rewards/useRewards';
import { classView } from '@/features/rewards/viewModel';
import { TripTopBar } from '@/features/trips/TopBar';
import { Button, Card, ListRow, Screen, Text, useTheme } from '@/ui';

import { settingsCopy } from './copy';
import { LinkRow, Section } from './parts';
import { SETTINGS_HREFS } from './routes';
import { useSignOutFlow } from './useSignOutFlow';

const copy = settingsCopy.root;

/** The first letter of the name, for the ghost portrait; a person glyph before there is one. */
export function initialOf(name: string | null | undefined): string | null {
  const first = Array.from((name ?? '').trim())[0];
  return first ? first.toLocaleUpperCase() : null;
}

/** The round portrait Home's header and this screen share. */
export function Portrait({ name, size = 44 }: { name: string | null | undefined; size?: number }) {
  const th = useTheme();
  const initial = initialOf(name);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: th.colors.accentFaint,
        borderWidth: 1,
        borderColor: th.colors.border,
      }}
    >
      {initial ? (
        <Text variant="headline" tone="accent" allowFontScaling={false}>
          {initial}
        </Text>
      ) : (
        <Ionicons name="person" size={size * 0.5} color={th.colors.accent} />
      )}
    </View>
  );
}

/**
 * H2 · Settings, as scope.md trims it: one list, reached from Home's portrait. Profile first, then
 * the driving settings, then the app's, then sign-out with its consequence stated before the press.
 * The camera row appears only where the camera beta is available (the remote flag, and an adult
 * account: entitlements come from the server's age band only).
 */
export function SettingsScreen() {
  const th = useTheme();
  const router = useRouter();
  const { profile } = useSession();
  const { config } = useAppConfig();
  const rewards = useRewards();
  const { signOut, signingOut } = useSignOutFlow();
  const back = router.canGoBack() ? () => router.back() : null;
  const go = (href: Href) => () => router.push(href);

  const klass = rewards.data ? classView(rewards.data.snapshot.progress) : null;
  const name = profile?.display_name?.trim() || homeCopy.card.noName;
  const cameraOffered = config.flags.camera_beta && profile?.age_band === '18_plus';
  const version = Constants.expoConfig?.version;

  return (
    <Screen scroll testID="settings">
      <TripTopBar title={settingsCopy.title} onBack={back} />

      <Card padded={false} variant="license" testID="settings-profile">
        <ListRow
          testID="settings-profile-row"
          title={name}
          subtitle={klass ? settingsCopy.profile.className(klass.name) : copy.profileHint}
          leading={<Portrait name={profile?.display_name} />}
          accessibilityHint={copy.profileHint}
          onPress={go(SETTINGS_HREFS.profile)}
        />
      </Card>

      <Section label={copy.driving} testID="settings-driving">
        <LinkRow
          testID="settings-detection"
          icon="navigate-outline"
          title={copy.detection.title}
          subtitle={copy.detection.subtitle}
          hint={copy.detection.hint}
          onPress={go(SETTINGS_HREFS.detection)}
        />
        <LinkRow
          testID="settings-alerts"
          icon="volume-medium-outline"
          title={copy.alerts.title}
          subtitle={copy.alerts.subtitle}
          hint={copy.alerts.hint}
          onPress={go(SETTINGS_HREFS.alerts)}
        />
        {cameraOffered ? (
          <LinkRow
            testID="settings-camera"
            icon="eye-outline"
            title={copy.camera.title}
            subtitle={copy.camera.subtitle}
            hint={copy.camera.hint}
            onPress={go(SETTINGS_HREFS.camera)}
          />
        ) : null}
      </Section>

      <Section label={copy.app} testID="settings-app">
        <LinkRow
          testID="settings-notifications"
          icon="notifications-outline"
          title={copy.notifications.title}
          subtitle={copy.notifications.subtitle}
          hint={copy.notifications.hint}
          onPress={go(SETTINGS_HREFS.notifications)}
        />
        <LinkRow
          testID="settings-privacy"
          icon="shield-checkmark-outline"
          title={copy.privacy.title}
          subtitle={copy.privacy.subtitle}
          hint={copy.privacy.hint}
          onPress={go(SETTINGS_HREFS.privacy)}
        />
        <LinkRow
          testID="settings-help"
          icon="help-circle-outline"
          title={copy.help.title}
          subtitle={copy.help.subtitle}
          hint={copy.help.hint}
          onPress={go(SETTINGS_HREFS.help)}
        />
      </Section>

      <View style={{ gap: th.space.xs }}>
        <Button
          testID="settings-sign-out"
          label={copy.signOut}
          variant="secondary"
          onPress={() => void signOut()}
          loading={signingOut}
          accessibilityHint={homeCopy.signOutWarning}
        />
        <Text variant="footnote" tone="muted">
          {homeCopy.signOutWarning}
        </Text>
      </View>
      {version ? (
        <Text variant="footnote" tone="subtle" style={{ textAlign: 'center' }} testID="settings-version">
          {copy.version(version)}
        </Text>
      ) : null}
    </Screen>
  );
}
