import { useEffect, useState } from 'react';
import { TextInput, useWindowDimensions, View } from 'react-native';

import { Button, Screen, Text, useTheme } from '@/ui';

import { CODE_LENGTH, RESEND_COOLDOWN_S, type ResendResult, type VerifyResult } from './emailPassword';

export const emailCodeCopy = {
  title: 'Check your email',
  sentTo: (email: string) => `We sent a 6-digit code to ${email}.`,
  codeLabel: '6-digit code',
  confirm: 'Confirm',
  tryAgain: 'Try again',
  resend: 'Resend code',
  resendIn: (seconds: number) => `Resend code in ${seconds} s`,
  resent: 'We sent a new code.',
  changeEmail: 'Use a different email',
  wrongCode: 'That code is wrong or has expired. Check it, or send a new one.',
  rateLimited: 'Too many tries. Try again in a minute.',
  offline: "You're offline. Check your connection and try again.",
  verifyFailed: "Couldn't confirm your email. Try again.",
  unfinished: "Couldn't finish signing you in. Check your connection and try again.",
  resendFailed: "Couldn't send a new code. Try again.",
} as const;

const VERIFY_ERRORS: Record<Exclude<VerifyResult, 'ok'>, string> = {
  wrong_code: emailCodeCopy.wrongCode,
  rate_limited: emailCodeCopy.rateLimited,
  offline: emailCodeCopy.offline,
  unfinished: emailCodeCopy.unfinished,
  error: emailCodeCopy.verifyFailed,
};

const RESEND_ERRORS: Record<Exclude<ResendResult, 'sent'>, string> = {
  rate_limited: emailCodeCopy.rateLimited,
  offline: emailCodeCopy.offline,
  error: emailCodeCopy.resendFailed,
};

/** Whole seconds left before Resend code may send again, from when the last code was asked for. */
export function resendWait(sentAt: number | null, now: number): number {
  if (sentAt === null) return 0;
  return Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_S * 1000 - now) / 1000));
}

/**
 * The code screen an email account confirms its address on: the 6-digit code from the confirmation
 * mail, typed in (or offered by iOS from the mail), checked as soon as all 6 digits are in. Resend
 * code waits out the server's minute between mails, and "Use a different email" goes back to the
 * form with everything typed there kept. The right code signs the driver in, and the usual
 * after-sign-in flow takes it from there (`onVerify` does what the form owes first). A right code
 * whose account could not be finished (`unfinished`) leaves the driver signed out with Try again
 * (`onFinish`) in place of Confirm; the code is spent by then, so the field and Resend code go.
 */
export function EmailCodeScreen({
  email,
  codeSent,
  initialError = null,
  onVerify,
  onFinish,
  onResend,
  onBack,
}: {
  email: string;
  /** A code was just asked for (Resend code waits a minute from now); false when none is known to have gone out. */
  codeSent: boolean;
  /** A line to show on arrival, such as a fresh code that couldn't be sent. */
  initialError?: string | null;
  onVerify: (code: string) => Promise<VerifyResult>;
  /** Finishes the account again after `unfinished`. */
  onFinish: () => Promise<VerifyResult>;
  onResend: () => Promise<ResendResult>;
  onBack: () => void;
}) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'verify' | 'resend' | 'done' | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(() => (codeSent ? Date.now() : null));
  const [now, setNow] = useState(() => Date.now());
  // The code was right but the account isn't finished: only Try again and the way back are left.
  const [unfinished, setUnfinished] = useState(false);
  const wait = resendWait(sentAt, now);

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

  const settle = async (attempt: () => Promise<VerifyResult>) => {
    setError(null);
    setNotice(null);
    setBusy('verify');
    const result = await attempt();
    if (result === 'ok') {
      // Signed in: the screen stays still until the route changes.
      setBusy('done');
      return;
    }
    if (result === 'unfinished') setUnfinished(true);
    setError(VERIFY_ERRORS[result]);
    setBusy(null);
  };

  const verify = (value: string) => {
    if (busy !== null || unfinished || value.length !== CODE_LENGTH) return;
    void settle(() => onVerify(value));
  };

  const retry = () => {
    if (busy !== null) return;
    void settle(onFinish);
  };

  const resend = async () => {
    if (busy !== null || wait > 0) return;
    setError(null);
    setNotice(null);
    setBusy('resend');
    const result = await onResend();
    const at = Date.now();
    if (result === 'sent') {
      // The code sent before no longer works.
      setCode('');
      setNotice(emailCodeCopy.resent);
    } else {
      setError(RESEND_ERRORS[result]);
    }
    // A refused send waits out the minute too: the server holds one mail per address a minute.
    if (result === 'sent' || result === 'rate_limited') setSentAt(at);
    setNow(at);
    setBusy(null);
  };

  const onChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
    const completes = digits.length === CODE_LENGTH && digits !== code;
    setCode(digits);
    if (completes) verify(digits);
  };

  return (
    <Screen scroll>
      <View style={{ gap: th.space.sm, paddingTop: th.space.xl }}>
        <Text variant="title1" accessibilityRole="header">
          {emailCodeCopy.title}
        </Text>
        <Text variant="body" tone="muted">
          {emailCodeCopy.sentTo(email)}
        </Text>
      </View>

      <View style={{ gap: th.space.sm }}>
        {unfinished ? (
          <Button
            label={emailCodeCopy.tryAgain}
            variant="secondary"
            onPress={retry}
            loading={busy === 'verify' || busy === 'done'}
            disabled={busy !== null}
          />
        ) : (
          <>
            <TextInput
              accessibilityLabel={emailCodeCopy.codeLabel}
              placeholder={emailCodeCopy.codeLabel}
              placeholderTextColor={th.colors.textMuted}
              value={code}
              onChangeText={onChange}
              editable={busy === null}
              autoFocus
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
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
              label={emailCodeCopy.confirm}
              variant="secondary"
              onPress={() => verify(code)}
              loading={busy === 'verify' || busy === 'done'}
              disabled={code.length !== CODE_LENGTH || busy !== null}
            />
            <Button
              label={wait > 0 ? emailCodeCopy.resendIn(wait) : emailCodeCopy.resend}
              variant="ghost"
              onPress={() => void resend()}
              loading={busy === 'resend'}
              disabled={wait > 0 || busy !== null}
            />
          </>
        )}
        <Button label={emailCodeCopy.changeEmail} variant="ghost" onPress={onBack} disabled={busy !== null} />
      </View>

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
    </Screen>
  );
}
