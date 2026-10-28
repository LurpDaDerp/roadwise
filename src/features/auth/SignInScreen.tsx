import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, TextInput, useWindowDimensions, View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { onboardingCopy } from '@/features/onboarding/copy';
import { localCheck, normaliseUsername } from '@/features/onboarding/steps/UsernameStep';
import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { EmailCodeScreen, emailCodeCopy } from './EmailCodeScreen';
import {
  claimChosenUsername,
  PASSWORD_MIN,
  registerWithPassword,
  resendEmailCode,
  signInWithPassword,
  startEmailConfirmation,
  type EmailConfirmation,
  type VerifyResult,
} from './emailPassword';
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
  rateLimited: 'Too many tries. Try again in a minute.',
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An address waiting for the code from its confirmation mail. A sign-up holds the username chosen
 * on the form, and its confirmation the password (in memory only), until the code confirms the
 * address.
 */
type PendingCode = {
  email: string;
  confirmation: EmailConfirmation;
  username: string | null;
  codeSent: boolean;
  error: string | null;
};

/**
 * The one sign-in screen: Sign in with Apple, Google, or an email and password, behind one
 * required checkbox. Nothing asks for an age or a birth date; the tick is the attestation, sent
 * after sign-in (`accept_terms`). An email account confirms its address on the code screen
 * (`EmailCodeScreen`) before it is signed in: after Create account, and after a sign-in to an
 * account whose address was never confirmed.
 */
export function SignInScreen() {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const apple = useAppleSignIn();
  const google = useGoogleSignIn();
  const { refreshProfile } = useSession();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { config } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'create' | 'signIn'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | null>(null);
  const [pending, setPending] = useState<PendingCode | null>(null);

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
  const creating = mode === 'create';
  const nameCheck = localCheck(username);
  const nameOk = nameCheck === null;
  const passwordOk = password.length >= PASSWORD_MIN;
  const mismatch = creating && confirm.length > 0 && confirm !== password;
  const canSubmit = !EMAIL_SHAPE.test(email.trim())
    ? false
    : creating
      ? nameOk && passwordOk && confirm === password
      : password.length > 0;

  // The name is claimed before the profile is read again, so setup finds it already taken and skips
  // its own username step.
  const claimUsername = async (name: string) => {
    if (await claimChosenUsername(name)) await refreshProfile().catch(() => {});
  };

  const submit = run('email', async () => {
    if (!creating) {
      const result = await signInWithPassword(email, password);
      if (result === 'unconfirmed') {
        // The right password on an address never confirmed: a fresh code, and the code screen. A
        // send refused for coming too soon means one went out within the minute, still good.
        const sent = await resendEmailCode(email);
        const went = sent === 'sent' || sent === 'rate_limited';
        setPending({
          email: email.trim(),
          confirmation: startEmailConfirmation(email, null),
          username: null,
          codeSent: went,
          error: went ? null : sent === 'offline' ? emailCodeCopy.offline : emailCodeCopy.resendFailed,
        });
        return;
      }
      if (result !== 'ok') {
        setError(
          result === 'invalid'
            ? t('signIn.credentialsInvalid')
            : result === 'rate_limited'
              ? signInCopy.rateLimited
              : t('signIn.errorGeneric')
        );
      }
      return;
    }
    const result = await registerWithPassword(email, password);
    if (result === 'ok') {
      await claimUsername(username);
      return;
    }
    if (result === 'confirm_email') {
      setPending({
        email: email.trim(),
        confirmation: startEmailConfirmation(email, password),
        username,
        codeSent: true,
        error: null,
      });
      return;
    }
    setError(
      result === 'exists'
        ? t('signIn.emailTaken')
        : result === 'weak_password'
          ? t('signIn.passwordWeak')
          : result === 'rate_limited'
            ? signInCopy.rateLimited
            : t('signIn.errorGeneric')
    );
  });

  if (pending !== null) {
    // The right code signs the driver in only once the account is theirs (`startEmailConfirmation`:
    // after a sign-up the password chosen on the form, and no other session); then the username
    // chosen on the form is claimed.
    const signedIn = async (result: VerifyResult): Promise<VerifyResult> => {
      if (result === 'ok' && pending.username !== null) await claimUsername(pending.username);
      return result;
    };
    return (
      <EmailCodeScreen
        email={pending.email}
        codeSent={pending.codeSent}
        initialError={pending.error}
        onVerify={async (code) => signedIn(await pending.confirmation.verify(code))}
        onFinish={async () => signedIn(await pending.confirmation.finish())}
        onResend={() => resendEmailCode(pending.email)}
        onBack={() => {
          void pending.confirmation.abandon();
          setPending(null);
        }}
      />
    );
  }

  const switchMode = () => {
    setError(null);
    setMode(creating ? 'signIn' : 'create');
    setPassword('');
    setConfirm('');
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

      <View style={{ gap: th.space.sm }} testID="email-password">
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
        {creating ? (
          <>
            <TextInput
              accessibilityLabel={t('signIn.usernameLabel')}
              accessibilityHint={onboardingCopy.username.rules}
              placeholder={t('signIn.usernameLabel')}
              placeholderTextColor={th.colors.textMuted}
              value={username}
              onChangeText={(v) => setUsername(normaliseUsername(v))}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              maxLength={24}
              textContentType="username"
              autoComplete="username-new"
              style={inputStyle}
            />
            {nameCheck?.state === 'invalid' ? (
              <Text variant="footnote" tone="danger">
                {onboardingCopy.username.reasons[nameCheck.reason]}
              </Text>
            ) : null}
          </>
        ) : null}
        <TextInput
          accessibilityLabel={t('signIn.passwordLabel')}
          placeholder={t('signIn.passwordLabel')}
          placeholderTextColor={th.colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={creating ? 'newPassword' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'}
          style={inputStyle}
        />
        {creating ? (
          <>
            <TextInput
              accessibilityLabel={t('signIn.passwordConfirmLabel')}
              placeholder={t('signIn.passwordConfirmLabel')}
              placeholderTextColor={th.colors.textMuted}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              autoComplete="new-password"
              style={inputStyle}
            />
            <Text variant="footnote" tone={mismatch || (password.length > 0 && !passwordOk) ? 'danger' : 'muted'}>
              {mismatch ? t('signIn.passwordMismatch') : t('signIn.passwordRule')}
            </Text>
          </>
        ) : null}
        <Button
          label={creating ? t('signIn.createAccount') : t('signIn.emailSignIn')}
          variant="secondary"
          onPress={submit}
          loading={busy === 'email'}
          disabled={!canSubmit || locked}
          accessibilityHint={lockedHint}
        />
        <Button
          label={creating ? t('signIn.modeSignIn') : t('signIn.modeCreate')}
          variant="ghost"
          onPress={switchMode}
          disabled={busy !== null}
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
