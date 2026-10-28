import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';

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

export const signInCopy = {
  title: 'Welcome to RoadWise',
  body: 'Build safe driving habits and see how you compare with friends.',
  attest: "I'm 13 or older and agree to the Terms and Privacy Policy",
  needsTick: 'Check the box above first.',
  saveFailed: "Couldn't save that. Try again.",
} as const;

/**
 * The one sign-in screen: Sign in with Apple or Google, behind one required checkbox. Nothing asks
 * for an age or a birth date; the tick is the attestation, sent after sign-in (`accept_terms`).
 */
export function SignInScreen() {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const apple = useAppleSignIn();
  const google = useGoogleSignIn();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { config } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apple' | 'google' | null>(null);

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
  const run = (key: 'apple' | 'google', fn: () => Promise<unknown>) => async () => {
    setError(null);
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      // The screen says only that it failed; the reason (a provider switched off on the server, a
      // client id that does not match) is in the Metro log for whoever is setting the app up.
      if (__DEV__) console.warn('[sign-in] ' + key + ':', e);
      setError(t('signIn.errorGeneric'));
    } finally {
      setBusy(null);
    }
  };

  const showApple = Platform.OS === 'ios' || apple.available;
  const locked = !agreed || busy !== null;
  const lockedHint = agreed ? undefined : signInCopy.needsTick;

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

      {error ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}
