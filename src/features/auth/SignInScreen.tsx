import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, TextInput, useWindowDimensions, View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { CODE_LENGTH, sendEmailCode, verifyEmailCode } from './emailCode';
import { legalState } from './legal';
import { LegalLinks } from './LegalLinks';
import { clearTermsAccepted, markTermsAccepted, startSignInVisit } from './pendingConsent';
import { useAppleSignIn } from './useAppleSignIn';
import { useGoogleSignIn } from './useGoogleSignIn';

export const signInCopy = {
  title: 'Welcome to RoadWise',
  body: 'Drive safely, earn points and climb the leagues with your friends.',
  attest: "I'm 13 or older and agree to the Terms and Privacy Policy",
  needsTick: 'Check the box above first.',
  saveFailed: "Couldn't save that. Try again.",
  rateLimited: 'Too many sign-in emails. Try again in a minute.',
  tooManyTries: 'Too many tries. Try again in a minute.',
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The one sign-in screen: Sign in with Apple, Google, or an emailed 6-digit code, behind one
 * required checkbox. Nothing asks for an age or a birth date; the tick is the attestation, sent
 * after sign-in (`accept_terms`).
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
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | 'verify' | null>(null);

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
  const run = (key: 'apple' | 'google' | 'email' | 'verify', fn: () => Promise<unknown>) => async () => {
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
  const canSend = EMAIL_SHAPE.test(email.trim());
  const canVerify = code.length === CODE_LENGTH;

  const requestCode = (again: boolean) =>
    run('email', async () => {
      const result = await sendEmailCode(email);
      if (result === 'sent') {
        setStage('code');
        setCode('');
        setResent(again);
      } else {
        setError(result === 'rate_limited' ? signInCopy.rateLimited : t('signIn.errorGeneric'));
      }
    });
  // A good code makes a session; `AuthGate` moves on from there, so nothing more happens here.
  const verify = run('verify', async () => {
    const result = await verifyEmailCode(email, code);
    if (result === 'ok') return;
    setError(
      result === 'invalid'
        ? t('signIn.codeInvalid')
        : result === 'rate_limited'
          ? signInCopy.tooManyTries
          : t('signIn.errorGeneric')
    );
  });
  const changeEmail = () => {
    setError(null);
    setStage('email');
    setCode('');
    setResent(false);
  };
  const inputStyle = {
    minHeight: 48 * scale,
    borderWidth: 1.5,
    borderColor: th.colors.borderStrong,
    borderRadius: th.radius.md,
    paddingHorizontal: th.space.md,
    color: th.colors.text,
    fontSize: 17 * scale,
  } as const;

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

      <View style={{ gap: th.space.sm }} testID="email-code">
        {stage === 'email' ? (
          <>
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
              textContentType="emailAddress"
              autoComplete="email"
              style={inputStyle}
            />
            <Button
              label={t('signIn.emailSend')}
              variant="secondary"
              onPress={requestCode(false)}
              loading={busy === 'email'}
              disabled={!canSend || locked}
              accessibilityHint={lockedHint}
            />
          </>
        ) : (
          <>
            <Text variant="callout" accessibilityLiveRegion="polite">
              {t('signIn.codeSent', { email: email.trim() })}
            </Text>
            <TextInput
              accessibilityLabel={t('signIn.codeLabel')}
              placeholder={t('signIn.codeLabel')}
              placeholderTextColor={th.colors.textMuted}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, CODE_LENGTH))}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              style={inputStyle}
            />
            <Button
              label={t('signIn.codeVerify')}
              onPress={verify}
              loading={busy === 'verify'}
              disabled={!canVerify || locked}
              accessibilityHint={lockedHint}
            />
            {resent ? (
              <Text variant="callout" tone="accent" accessibilityLiveRegion="polite">
                {t('signIn.codeResent')}
              </Text>
            ) : null}
            <Button
              label={t('signIn.codeResend')}
              variant="ghost"
              onPress={requestCode(true)}
              loading={busy === 'email'}
              disabled={locked}
            />
            <Button label={t('signIn.codeChange')} variant="ghost" onPress={changeEmail} disabled={busy !== null} />
          </>
        )}
      </View>

      {error ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}
