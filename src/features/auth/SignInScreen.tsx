import { useState } from 'react';
import { Platform, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';

import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { useAppleSignIn } from './useAppleSignIn';
import { useGoogleSignIn } from './useGoogleSignIn';
import { useMagicLink } from './useMagicLink';

/**
 * The counter at the licensing office: three ways to prove who you are, in the order a phone owner
 * expects them — the platform's own button first, then Google, then the email fallback that works
 * on any device. Every failure is answered in place; nothing is delegated to an alert.
 */
export function SignInScreen() {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const apple = useAppleSignIn();
  const google = useGoogleSignIn();
  const magic = useMagicLink();
  const [email, setEmail] = useState('');
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = email.trim().includes('@');
  const run = (fn: () => Promise<unknown>) => () => {
    setError(null);
    fn().catch(() => setError(t('signIn.errorGeneric')));
  };
  const submit = run(() => magic.send(email.trim()));
  // `available` only ever turns true on iOS, and it resolves a tick after the first paint, so the
  // platform check is what keeps the button from popping into the stack under the driver's thumb.
  const showApple = Platform.OS === 'ios' || apple.available;

  return (
    <Screen scroll>
      <Text variant="title1" accessibilityRole="header">
        {t('signIn.title')}
      </Text>

      <View style={{ gap: th.space.md }}>
        {showApple ? (
          <Button label={t('signIn.apple')} variant="secondary" onPress={run(apple.signIn)} />
        ) : null}
        <Button
          label={t('signIn.google')}
          variant="secondary"
          onPress={run(google.signIn)}
          disabled={!google.ready}
        />
      </View>

      <View
        style={{
          gap: th.space.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: th.colors.border,
          paddingTop: th.space.lg,
        }}
      >
        <Text
          variant="caption"
          tone="muted"
          style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}
        >
          {t('signIn.emailLabel')}
        </Text>
        <TextInput
          accessibilityLabel={t('signIn.emailLabel')}
          value={email}
          onChangeText={setEmail}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={canSend ? submit : undefined}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          inputMode="email"
          selectionColor={th.colors.accent}
          // Dynamic Type is applied by hand, exactly as `Text` does it, so the field grows with the
          // type instead of clipping it at the larger accessibility sizes.
          allowFontScaling={false}
          style={{
            minHeight: 48 * scale,
            borderWidth: 1.5,
            borderColor: focused ? th.colors.accent : th.colors.borderStrong,
            borderRadius: th.radius.md,
            paddingHorizontal: th.space.md,
            color: th.colors.text,
            fontSize: 17 * scale,
          }}
        />
        <Button
          label={t('signIn.magicLink')}
          onPress={submit}
          loading={magic.state === 'sending'}
          disabled={!canSend}
        />
      </View>

      {magic.state === 'sent' ? (
        <Text variant="callout" tone="accent" accessibilityLiveRegion="polite">
          {t('signIn.magicLinkSent')}
        </Text>
      ) : null}
      {error || magic.state === 'error' ? (
        <Text
          variant="callout"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error ?? t('signIn.errorGeneric')}
        </Text>
      ) : null}
    </Screen>
  );
}
