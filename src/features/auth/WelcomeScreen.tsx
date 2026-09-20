import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { t } from '@/i18n';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

/**
 * The first thing a new driver sees. The promise is set in the display face, and the card face
 * underneath it is the licence they are here to earn — so the screen shows the reward before it
 * asks for anything. One action carries the screen; the returning driver gets the quiet one.
 */
export function WelcomeScreen() {
  const router = useRouter();
  const th = useTheme();
  // Both routes land on the same screen on purpose: Apple, Google and the magic link each create
  // the account on first use, so there is no separate sign-up to send anyone to.
  const toSignIn = () => router.push('/(auth)/sign-in');

  return (
    <Screen scroll>
      <View style={{ flexGrow: 1, justifyContent: 'center', gap: th.space.xl }}>
        <Text variant="display" accessibilityRole="header">
          {t('welcome.headline')}
        </Text>
        <Card variant="license">
          <Text variant="body">{t('welcome.body')}</Text>
        </Card>
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
