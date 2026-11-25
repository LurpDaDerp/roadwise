import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { t } from '@/i18n';
import { Button, Screen, Text, useAnnounce, useTheme } from '@/ui';

import { AuthField } from './AuthField';
import { EmailCodeScreen, emailCodeCopy } from './EmailCodeScreen';
import {
  EMAIL_SHAPE,
  PASSWORD_MAX,
  passwordProblem,
  registerWithPassword,
  resendEmailCode,
  signInWithPassword,
  startEmailConfirmation,
  type EmailConfirmation,
  type RegisterResult,
  type SignInResult,
} from './emailPassword';
import { LegalLinks } from './LegalLinks';
import { PasswordResetScreen } from './PasswordResetScreen';
import { clearTermsAccepted, markTermsAccepted, startSignInVisit } from './pendingConsent';
import { useAppleSignIn } from './useAppleSignIn';
import { useGoogleSignIn } from './useGoogleSignIn';

export const signInCopy = {
  title: 'Welcome to RoadWise',
  body: 'Build safe driving habits and see how you compare with friends.',
  attest: "I'm 13 or older and agree to the Terms and Privacy Policy",
  needsTick: 'Select the checkbox above first.',
  saveFailed: "Couldn't save that. Try again.",
} as const;

/** The three ways in. */
type Way = 'apple' | 'google' | 'email';

/**
 * An address waiting for the code from its confirmation mail. A sign-up's confirmation holds the
 * password chosen on the form (in memory only) until the code confirms the address.
 */
type PendingCode = {
  email: string;
  confirmation: EmailConfirmation;
  codeSent: boolean;
  error: string | null;
};

const REGISTER_ERRORS: Record<Exclude<RegisterResult, 'ok' | 'confirm_email'>, () => string> = {
  exists: () => t('signIn.emailTaken'),
  weak_password: () => t('signIn.passwordWeak'),
  invalid_email: () => t('signIn.emailInvalid'),
  rate_limited: () => t('signIn.rateLimited'),
  offline: () => t('signIn.offline'),
  error: () => t('signIn.errorGeneric'),
};

const SIGN_IN_ERRORS: Record<Exclude<SignInResult, 'ok' | 'unconfirmed'>, () => string> = {
  invalid: () => t('signIn.credentialsInvalid'),
  rate_limited: () => t('signIn.rateLimited'),
  offline: () => t('signIn.offline'),
  error: () => t('signIn.errorGeneric'),
};

/**
 * The one sign-in screen: Sign in with Apple, Google, or an email and password, behind one
 * required checkbox. Nothing asks for an age or a birth date; the tick is the attestation, sent
 * after sign-in (`accept_terms`). An email account confirms its address on the code screen
 * (`EmailCodeScreen`) before it is signed in: after Create account, and after a sign-in to an
 * account whose address was never confirmed. Forgot password opens `PasswordResetScreen`. Setup
 * (username first) follows every way in alike.
 */
export function SignInScreen() {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const apple = useAppleSignIn();
  const google = useGoogleSignIn();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { session } = useSession();

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Way | null>(null);
  // The way in last tapped. Once its sign-in has made a session, the screen holds as it was while
  // the sign-in ran (that button's spinner, everything else off) until the gate moves the driver
  // on, which waits for the profile read (up to 10 s): re-armed in that gap, a second tap would
  // start a second sign-in. A session that ends first lifts the hold.
  const [tapped, setTapped] = useState<Way | null>(null);
  const held = busy ?? (session !== null ? tapped : null);
  const [mode, setMode] = useState<'create' | 'signIn'>('create');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState<PendingCode | null>(null);
  const [resetting, setResetting] = useState(false);
  // Set in the same tick as a press, so a second tap in that frame can't start a second sign-in.
  const inFlight = useRef(false);

  // Every visit starts unticked, and a tick left from an earlier visit is dropped.
  useEffect(() => {
    void startSignInVisit(settings);
  }, [settings]);

  // A confirmation is given up when the code screen goes, however it goes ("Use a different email",
  // or this screen leaving): a right code's session not yet handed to the app is signed out. Once
  // handed over (the driver signed in, so this screen leaves), there is nothing left to give up.
  useEffect(() => {
    if (pending === null) return;
    const { confirmation } = pending;
    return () => {
      void confirmation.abandon();
    };
  }, [pending]);

  // A failed sign-in's line shows at the foot of the form while the screen reader stays on the
  // button that was tapped, so it is read out as it appears (`useAnnounce`, on both platforms).
  useAnnounce(error);

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
  const run = (key: Way, fn: () => Promise<unknown>) => async () => {
    if (held !== null || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(key);
    setTapped(key);
    try {
      await fn();
    } catch (e) {
      // The screen says only that it failed; the reason (a provider switched off on the server, a
      // client id that does not match) is in the Metro log for whoever is setting the app up.
      if (__DEV__) console.warn('[sign-in] ' + key + ':', e);
      setTapped(null);
      setError(t('signIn.errorGeneric'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const showApple = Platform.OS === 'ios' || apple.available;
  const locked = !agreed || held !== null;
  const lockedHint = agreed ? undefined : signInCopy.needsTick;
  const creating = mode === 'create';
  const problem = passwordProblem(password, email);
  const mismatch = creating && confirm.length > 0 && confirm !== password;
  const canSubmit = !EMAIL_SHAPE.test(email.trim())
    ? false
    : creating
      ? problem === null && confirm === password
      : password.length > 0;

  const submit = run('email', async () => {
    if (!canSubmit) return;
    if (!creating) {
      const result = await signInWithPassword(email, password);
      if (result === 'ok') return;
      if (result === 'unconfirmed') {
        // The right password on an address never confirmed: a fresh code, and the code screen. Auth
        // refusing a second mail within the minute (`too_soon`) means one went out then, still good;
        // any other refusal sent nothing, and the screen says why. The server clears an address's
        // password when it is first confirmed, so the code sets the one just typed again.
        const sent = await resendEmailCode(email);
        const went = sent === 'sent' || sent === 'too_soon';
        setPending({
          email: email.trim(),
          confirmation: startEmailConfirmation(email, password),
          codeSent: went,
          error: went
            ? null
            : sent === 'offline'
              ? emailCodeCopy.offline
              : sent === 'rate_limited'
                ? emailCodeCopy.rateLimited
                : emailCodeCopy.resendFailed,
        });
        return;
      }
      setError(SIGN_IN_ERRORS[result]());
      return;
    }
    const result = await registerWithPassword(email, password);
    if (result === 'ok') return;
    if (result === 'confirm_email') {
      setPending({
        email: email.trim(),
        confirmation: startEmailConfirmation(email, password),
        codeSent: true,
        error: null,
      });
      return;
    }
    setError(REGISTER_ERRORS[result]());
  });

  if (pending !== null) {
    // The right code signs the driver in only once the account is theirs (`startEmailConfirmation`:
    // after a sign-up the password chosen on the form, and no other session).
    return (
      <EmailCodeScreen
        email={pending.email}
        codeSent={pending.codeSent}
        initialError={pending.error}
        onVerify={(code) => pending.confirmation.verify(code)}
        onFinish={() => pending.confirmation.finish()}
        onResend={() => resendEmailCode(pending.email)}
        onBack={() => setPending(null)}
      />
    );
  }

  if (resetting) {
    return <PasswordResetScreen initialEmail={email} onBack={() => setResetting(false)} />;
  }

  const switchMode = () => {
    setError(null);
    setMode(creating ? 'signIn' : 'create');
    setPassword('');
    setConfirm('');
  };

  const openReset = () => {
    if (locked) return;
    setError(null);
    setPassword('');
    setResetting(true);
  };

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
          <LegalLinks />
        </View>
      </View>

      <View style={{ gap: th.space.md }}>
        {showApple ? (
          <Button
            label={t('signIn.apple')}
            icon="logo-apple"
            onPress={run('apple', apple.signIn)}
            loading={held === 'apple'}
            disabled={locked}
            accessibilityHint={lockedHint}
          />
        ) : null}
        <Button
          label={t('signIn.google')}
          variant="secondary"
          onPress={run('google', google.signIn)}
          loading={held === 'google'}
          disabled={!google.ready || locked}
          accessibilityHint={lockedHint}
        />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }} importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View style={{ flex: 1, height: 1, backgroundColor: th.colors.borderStrong }} />
        <Text variant="footnote" tone="muted">
          {t('signIn.or')}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: th.colors.borderStrong }} />
      </View>

      <View style={{ gap: th.space.sm }} testID="email-password">
        <AuthField
          label={t('signIn.emailLabel')}
          value={email}
          onChangeText={setEmail}
          editable={held === null}
          keyboardType="email-address"
          inputMode="email"
          // The account name a password manager saves with the password, on both forms.
          textContentType="username"
          autoComplete="email"
        />
        <AuthField
          label={t('signIn.passwordLabel')}
          value={password}
          onChangeText={setPassword}
          editable={held === null}
          secureTextEntry
          maxLength={PASSWORD_MAX}
          textContentType={creating ? 'newPassword' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'}
        />
        {creating ? (
          <>
            <AuthField
              label={t('signIn.passwordConfirmLabel')}
              value={confirm}
              onChangeText={setConfirm}
              editable={held === null}
              secureTextEntry
              maxLength={PASSWORD_MAX}
              textContentType="newPassword"
              autoComplete="new-password"
            />
            <Text
              variant="footnote"
              tone={mismatch || (password.length > 0 && problem !== null) ? 'danger' : 'muted'}
            >
              {mismatch
                ? t('signIn.passwordMismatch')
                : problem === 'long'
                  ? t('signIn.passwordTooLong')
                  : problem === 'common'
                    ? t('signIn.passwordCommon')
                    : t('signIn.passwordRule')}
            </Text>
          </>
        ) : null}
        <Button
          label={creating ? t('signIn.createAccount') : t('signIn.emailSignIn')}
          variant="secondary"
          onPress={submit}
          loading={held === 'email'}
          disabled={!canSubmit || locked}
          accessibilityHint={lockedHint}
        />
        <Button
          label={creating ? t('signIn.modeSignIn') : t('signIn.modeCreate')}
          variant="ghost"
          onPress={switchMode}
          disabled={held !== null}
        />
        {creating ? null : (
          <Button
            label={t('signIn.forgotPassword')}
            variant="ghost"
            onPress={openReset}
            disabled={locked}
            accessibilityHint={lockedHint}
          />
        )}
      </View>

      {/* No live region: `useAnnounce` reads it on Android too, and a live region as well could say it twice. */}
      {error ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}
