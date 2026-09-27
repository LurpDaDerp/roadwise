import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

/**
 * A2 Welcome. One headline, one line on what the app does, and the way in. Both buttons land on
 * sign-in on purpose: Apple, Google and the magic link each create the account on first use, so
 * there is no separate sign-up to send anyone to.
 */
export function WelcomeScreen() {
  const router = useRouter();
  const th = useTheme();
  const toSignIn = () => router.push('/(auth)/sign-in');

  return (
    <Screen scroll>
      <View style={{ flexGrow: 1, justifyContent: 'center', gap: th.space.md }}>
        <Text variant="display" accessibilityRole="header">
          {t('welcome.headline')}
        </Text>
        <Text variant="body" tone="muted">
          {t('welcome.body')}
        </Text>
      </View>

      <View style={{ gap: th.space.sm }}>
        <Text variant="footnote" tone="subtle">
          {t('welcome.privacy')}
        </Text>
        <Button label={t('welcome.getStarted')} onPress={toSignIn} />
        <Button label={t('welcome.signIn')} variant="ghost" onPress={toSignIn} />
      </View>
    </Screen>
  );
}
