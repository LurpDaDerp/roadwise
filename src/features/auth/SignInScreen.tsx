import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, TextInput, useWindowDimensions, View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { legalState } from './legal';
import { LegalLinks } from './LegalLinks';
import { clearTermsAccepted, markTermsAccepted, startSignInVisit } from './pendingConsent';
import { useAppleSignIn } from './useAppleSignIn';
import { useGoogleSignIn } from './useGoogleSignIn';
import { useMagicLink } from './useMagicLink';

export const signInCopy = {
  title: 'Welcome to RoadWise',
  body: 'Drive safely, earn points and climb the leagues with your friends.',
  attest: "I'm 13 or older and agree to the Terms and Privacy Policy",
  needsTick: 'Check the box above first.',
  saveFailed: "Couldn't save that. Try again.",
  rateLimited: 'Too many sign-in emails. Try again in a minute.',
} as const;

/** The email magic link is for local testing only (`EXPO_PUBLIC_DIAGNOSTICS=1`). */
export const magicLinkEnabled = (): boolean => process.env.EXPO_PUBLIC_DIAGNOSTICS === '1';

/**
 * The one sign-in screen: Sign in with Apple and Google, behind one required checkbox. Nothing asks
 * for an age or a birth date; the tick is the attestation, sent after sign-in (`accept_terms`).
 */
export function SignInScreen({ showMagicLink = magicLinkEnabled() }: { showMagicLink?: boolean }) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const apple = useAppleSignIn();
  const google = useGoogleSignIn();
  const magic = useMagicLink();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { config } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | null>(null);

  // Every visit starts unticked, and a tick left from an earlier visit is dropped.
  useEffect(() => {
    void startSignInVisit(settings);
  }, [settings]);

  const toggle = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      if (agreed) {
        setAgreed(false);
        await clearTermsAccepted(settings);
      } else {
        await markTermsAccepted(settings);
        setAgreed(true);
      }
    } catch {
      setError(signInCopy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // One sign-in at a time: a second tap while a sheet is opening would stack two of them.
  const run = (key: 'apple' | 'google' | 'email', fn: () => Promise<unknown>) => async () => {
    setError(null);
    setBusy(key);
    try {
      await fn();
    } catch {
      setError(t('signIn.errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const showApple = Platform.OS === 'ios' || apple.available;
  const locked = !agreed || busy !== null;
  const lockedHint = agreed ? undefined : signInCopy.needsTick;
  const canSend = email.trim().includes('@');
  const submit = run('email', () => magic.send(email.trim()));

  return (
    <Screen scroll>
      <View style={{ gap: th.space.sm, paddingTop: th.space.xl }}>
        <Text variant="title1" accessibilityRole="header">
          {signInCopy.title}
        </Text>
        <Text variant="body" tone="muted">
          {signInCopy.body}
        </Text>
      </View>

      <View style={{ flexGrow: 1 }} />

      <View style={{ gap: th.space.xs }}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={signInCopy.attest}
          accessibilityState={{ checked: agreed, busy: saving }}
          onPress={() => void toggle()}
          testID="terms-checkbox"
          style={({ pressed }) => ({
            minHeight: 44 * scale,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: th.space.md,
            paddingVertical: th.space.sm,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <View
            style={{
              width: 24 * scale,
              height: 24 * scale,
              marginTop: 1 * scale,
              borderRadius: th.radius.sm / 2,
              borderWidth: 2,
              borderColor: agreed ? th.colors.accent : th.colors.borderStrong,
              backgroundColor: agreed ? th.colors.accent : th.colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {agreed ? <Ionicons name="checkmark" size={18 * scale} color={th.colors.accentText} /> : null}
          </View>
          <Text variant="callout" style={{ flex: 1 }}>
            {signInCopy.attest}
          </Text>
        </Pressable>
        <View style={{ paddingLeft: 24 * scale + th.space.md }}>
          <LegalLinks legal={legal} />
        </View>
      </View>

      <View style={{ gap: th.space.md }}>
        {showApple ? (
          <Button
            label={t('signIn.apple')}
            onPress={run('apple', apple.signIn)}
            loading={busy === 'apple'}
            disabled={locked}
            accessibilityHint={lockedHint}
          />
        ) : null}
        <Button
          label={t('signIn.google')}
          variant="secondary"
          onPress={run('google', google.signIn)}
          loading={busy === 'google'}
          disabled={!google.ready || locked}
          accessibilityHint={lockedHint}
        />
      </View>

      {showMagicLink ? (
        <View style={{ gap: th.space.sm }} testID="magic-link">
          <TextInput
            accessibilityLabel={t('signIn.emailLabel')}
            placeholder={t('signIn.emailLabel')}
            placeholderTextColor={th.colors.textMuted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            inputMode="email"
            style={{
              minHeight: 48 * scale,
              borderWidth: 1.5,
              borderColor: th.colors.borderStrong,
              borderRadius: th.radius.md,
              paddingHorizontal: th.space.md,
              color: th.colors.text,
              fontSize: 17 * scale,
            }}
          />
          <Button
            label={t('signIn.magicLink')}
            variant="secondary"
            onPress={submit}
            loading={busy === 'email' || magic.state === 'sending'}
            disabled={!canSend || locked}
            accessibilityHint={lockedHint}
          />
          {magic.state === 'sent' ? (
            <Text variant="callout" tone="accent" accessibilityLiveRegion="polite">
              {t('signIn.magicLinkSent')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {error || magic.state === 'error' || magic.state === 'rate_limited' ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error ?? (magic.state === 'rate_limited' ? signInCopy.rateLimited : t('signIn.errorGeneric'))}
        </Text>
      ) : null}
    </Screen>
  );
}
