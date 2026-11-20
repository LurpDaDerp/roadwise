import { useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';

import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { AuthField } from './AuthField';
import { resendWait } from './EmailCodeScreen';
import {
  CODE_LENGTH,
  EMAIL_SHAPE,
  PASSWORD_MAX,
  passwordProblem,
  requestPasswordReset,
  startEmailConfirmation,
  type EmailConfirmation,
  type ResendResult,
  type VerifyResult,
} from './emailPassword';

export const resetCopy = {
  title: 'Reset your password',
  body: "Type your account's email. We'll send it an 8-digit code, and you'll choose a new password.",
  send: 'Send code',
  back: 'Back to sign in',
  codeTitle: 'Check your email',
  sentTo: (email: string) =>
    `If ${email} has a RoadWise password, we sent an 8-digit code to it. If you sign in with Apple or Google, the email says so instead.`,
  codeLabel: '8-digit code',
  newPassword: 'New password',
  confirmPassword: 'Confirm new password',
  setPassword: 'Set new password',
  tryAgain: 'Try again',
  resend: 'Resend code',
  resendIn: (seconds: number) => `Resend code in ${seconds} s`,
  resent: 'We sent a new code.',
  changeEmail: 'Use a different email',
  wrongCode: 'That code is wrong or has expired. Check it, or send a new one.',
  rateLimited: 'Too many tries. Try again later.',
  offline: "You're offline. Check your connection and try again.",
  verifyFailed: "Couldn't reset your password. Try again.",
  unfinished: "Couldn't finish signing you in. Check your connection and try again.",
  sendFailed: "Couldn't send a code. Try again.",
} as const;

const VERIFY_ERRORS: Record<Exclude<VerifyResult, 'ok'>, string> = {
  wrong_code: resetCopy.wrongCode,
  rate_limited: resetCopy.rateLimited,
  offline: resetCopy.offline,
  unfinished: resetCopy.unfinished,
  error: resetCopy.verifyFailed,
};

const SEND_ERRORS: Record<Exclude<ResendResult, 'sent' | 'too_soon'>, string> = {
  rate_limited: resetCopy.rateLimited,
  offline: resetCopy.offline,
  error: resetCopy.sendFailed,
};

/**
 * Forgot password. First the account's email (taken from the sign-in form), then Send code mails it
 * an 8-digit reset code; Auth answers the same whether or not the address has an account, so the
 * next step says "If … has a RoadWise account". There the code, the new password and the password
 * again set it: the code signs in on an aside client, the new password becomes the account's, every
 * other session is signed out, and only then is the driver signed in (`startEmailConfirmation`,
 * `recovery`). A right code whose account could not be finished leaves only Try again (the code is
 * spent). Resend code waits out the server's minute; "Use a different email" and Android's back
 * button go back a step, and Back to sign in (or back from the first step) leaves.
 */
export function PasswordResetScreen({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const th = useTheme();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(initialEmail.trim());
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | 'resend' | 'done' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The code was right but the account isn't finished: only Try again and the way back are left.
  const [unfinished, setUnfinished] = useState(false);
  const confirmation = useRef<EmailConfirmation | null>(null);
  // Set in the same tick as a press, so a second event in that frame can't start a second request
  // (a second code check would give up the first while it is still out).
  const inFlight = useRef(false);
  const wait = resendWait(sentAt, now);

  // A session a right code signed in, not yet handed to the app, goes when the screen does.
  useEffect(
    () => () => {
      void confirmation.current?.abandon();
    },
    []
  );

  // A once-a-second tick, only while Resend code is waiting.
  useEffect(() => {
    if (resendWait(sentAt, Date.now()) === 0) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (resendWait(sentAt, at) === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  const toEmailStep = () => {
    void confirmation.current?.abandon();
    confirmation.current = null;
    setUnfinished(false);
    setCode('');
    setPassword('');
    setConfirm('');
    setError(null);
    setNotice(null);
    setStep('email');
  };

  // Android's back button goes back one step, never out of the app; it waits while a request is out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy === null) {
        if (step === 'code') toEmailStep();
        else onBack();
      }
      return true;
    });
    return () => sub.remove();
  }, [busy, step, onBack]);

  const send = async (resending: boolean) => {
    if (busy !== null || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setNotice(null);
    setBusy(resending ? 'resend' : 'send');
    const result = await requestPasswordReset(email).finally(() => {
      inFlight.current = false;
    });
    const at = Date.now();
    const went = result === 'sent' || result === 'too_soon';
    // A refused send waits out the minute too: the server holds one mail per address a minute.
    if (went || result === 'rate_limited') setSentAt(at);
    setNow(at);
    setBusy(null);
    if (!went) {
      setError(SEND_ERRORS[result]);
      return;
    }
    if (resending && result === 'sent') {
      // The code sent before no longer works.
      setCode('');
      setNotice(resetCopy.resent);
    }
    setStep('code');
  };

  const problem = passwordProblem(password, email);
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = code.length === CODE_LENGTH && problem === null && confirm === password;

  const submit = async () => {
    if (busy !== null || inFlight.current || (!unfinished && !ready)) return;
    inFlight.current = true;
    setError(null);
    setNotice(null);
    setBusy('verify');
    let result: VerifyResult;
    const held = confirmation.current;
    if (unfinished && held !== null) {
      result = await held.finish();
    } else {
      // Each try checks the code with the password as typed now; a try that failed holds nothing.
      void held?.abandon();
      const next = startEmailConfirmation(email, password, 'recovery');
      confirmation.current = next;
      result = await next.verify(code);
    }
    inFlight.current = false;
    if (result === 'ok') {
      // Signed in: the screen stays still until the route changes.
      setBusy('done');
      return;
    }
    if (result === 'unfinished') setUnfinished(true);
    setError(VERIFY_ERRORS[result]);
    setBusy(null);
  };

  const onCodeChange = (text: string) => setCode(text.replace(/\D/g, '').slice(0, CODE_LENGTH));

  const feedback = (
    <>
      {notice ? (
        <Text variant="callout" tone="muted" accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
      {error ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </>
  );

  if (step === 'email') {
    return (
      <Screen scroll>
        <View style={{ gap: th.space.sm, paddingTop: th.space.xl }}>
          <Text variant="title1" accessibilityRole="header">
            {resetCopy.title}
          </Text>
          <Text variant="body" tone="muted">
            {resetCopy.body}
          </Text>
        </View>
        <View style={{ gap: th.space.sm }}>
          <AuthField
            label={t('signIn.emailLabel')}
            value={email}
            onChangeText={setEmail}
            editable={busy === null}
            keyboardType="email-address"
            inputMode="email"
            textContentType="emailAddress"
            autoComplete="email"
          />
          <Button
            label={resetCopy.send}
            variant="secondary"
            onPress={() => void send(false)}
            loading={busy === 'send'}
            disabled={!EMAIL_SHAPE.test(email.trim()) || busy !== null}
          />
          <Button label={resetCopy.back} variant="ghost" onPress={onBack} disabled={busy !== null} />
        </View>
        {feedback}
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View style={{ gap: th.space.sm, paddingTop: th.space.xl }}>
        <Text variant="title1" accessibilityRole="header">
          {resetCopy.codeTitle}
        </Text>
        <Text variant="body" tone="muted">
          {resetCopy.sentTo(email.trim())}
        </Text>
      </View>

      <View style={{ gap: th.space.sm }}>
        {unfinished ? (
          <Button
            label={resetCopy.tryAgain}
            variant="secondary"
            onPress={() => void submit()}
            loading={busy === 'verify' || busy === 'done'}
            disabled={busy !== null}
          />
        ) : (
          <>
            <AuthField
              label={resetCopy.codeLabel}
              value={code}
              onChangeText={onCodeChange}
              editable={busy === null}
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              // No maxLength: a pasted "1234 5678" must reach onCodeChange whole; it keeps the first 8 digits.
            />
            <AuthField
              label={resetCopy.newPassword}
              value={password}
              onChangeText={setPassword}
              editable={busy === null}
              secureTextEntry
              maxLength={PASSWORD_MAX}
              textContentType="newPassword"
              autoComplete="new-password"
            />
            <AuthField
              label={resetCopy.confirmPassword}
              value={confirm}
              onChangeText={setConfirm}
              editable={busy === null}
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
            <Button
              label={resetCopy.setPassword}
              variant="secondary"
              onPress={() => void submit()}
              loading={busy === 'verify' || busy === 'done'}
              disabled={!ready || busy !== null}
            />
            <Button
              label={wait > 0 ? resetCopy.resendIn(wait) : resetCopy.resend}
              variant="ghost"
              onPress={() => void send(true)}
              loading={busy === 'resend'}
              disabled={wait > 0 || busy !== null}
            />
          </>
        )}
        <Button label={resetCopy.changeEmail} variant="ghost" onPress={toEmailStep} disabled={busy !== null} />
      </View>
      {feedback}
    </Screen>
  );
}
