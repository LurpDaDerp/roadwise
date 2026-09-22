import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { t } from '@/i18n';
import { Button, Screen, Text, useTheme } from '@/ui';

import { DISCLAIMER_VERSION, legalState, SAFETY_DISCLAIMER, type LegalState } from './legal';
import { LegalLinks } from './LegalLinks';
import {
  clearTermsAccepted,
  currentSignInVisit,
  forgetLinkVisit,
  handVisitToLink,
  markTermsAccepted,
  startSignInVisit,
} from './pendingConsent';
import { useAppleSignIn } from './useAppleSignIn';
import { useGoogleSignIn } from './useGoogleSignIn';
import { useMagicLink } from './useMagicLink';

/**
 * A3's words. The disclaimer is quoted from `legal.ts` unchanged; the full stop is added here, where
 * it is displayed. Kept beside the screen until `en.ts` has an owner who can take them.
 */
export const signInLegalCopy = {
  acknowledge: `I understand that ${SAFETY_DISCLAIMER}.`,
  agree: 'I agree to the Terms and Privacy Policy.',
  needsTick: 'Tick the box above first.',
  saveFailed: "Couldn't save that. Try again.",
  rateLimited: 'Too many sign-in emails. Try again in a minute.',
} as const;

/**
 * What a tick is given to. A tick counts only for the exact thing it was given to: when the server
 * publishes the documents (or new versions of them) after the driver ticked, the box clears and
 * asks again, because the earlier tick was not consent to them.
 */
const tickSubject = (legal: LegalState): string =>
  legal.published && legal.tos && legal.privacy
    ? `terms:${legal.tos.version}:${legal.privacy.version}:${DISCLAIMER_VERSION}`
    : `disclaimer:${DISCLAIMER_VERSION}`;

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
  const [busy, setBusy] = useState<'apple' | 'google' | 'email' | null>(null);

  // A3 (rev1: I7): the tick comes before any way in. Published, it acknowledges the disclaimer and
  // accepts both documents; unpublished, it acknowledges the disclaimer and nothing else — nobody
  // is asked to accept a document that cannot be opened.
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { config, ready } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);
  const subject = tickSubject(legal);
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const agreed = tickedFor === subject;

  // Every visit to this screen is a new visit (T17 round 2): the box starts unticked, a tick is
  // stored with this visit's in-memory token, and no tick from an earlier visit — or a link an
  // earlier visit was waiting on — is honoured any more. See `pendingConsent.ts`.
  useEffect(() => {
    startSignInVisit();
    void forgetLinkVisit(settings);
  }, [settings]);

  const toggle = async () => {
    if (saving || !ready) return;
    setError(null);
    setSaving(true);
    try {
      if (agreed) {
        // Withdrawn before signing in: no Terms acceptance is left to be recorded on the account.
        // The disclaimer acknowledgement is a device preference and stays (T15 r2).
        setTickedFor(null);
        await clearTermsAccepted(settings);
      } else {
        await markTermsAccepted(settings, legal);
        setTickedFor(subject);
      }
    } catch {
      setError(signInLegalCopy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const canSend = email.trim().includes('@');
  // One sign-in at a time. A second tap while the Apple sheet is opening would stack two of them,
  // and the driver would be answering a dialog they cannot see the first of.
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
  // The link may reopen the app after it was closed, which forgets the in-memory visit: hand this
  // visit to the link first, so the tick made here is still honoured when it lands.
  const submit = run('email', async () => {
    const visit = currentSignInVisit();
    if (visit) await handVisitToLink(settings, visit);
    return magic.send(email.trim());
  });
  // `available` only ever turns true on iOS, and it resolves a tick after the first paint, so the
  // platform check is what keeps the button from popping into the stack under the driver's thumb.
  const showApple = Platform.OS === 'ios' || apple.available;
  const locked = !agreed || busy !== null;
  const lockedHint = agreed ? undefined : signInLegalCopy.needsTick;
  const tickLabel = legal.published
    ? `${signInLegalCopy.acknowledge} ${signInLegalCopy.agree}`
    : signInLegalCopy.acknowledge;

  return (
    <Screen scroll>
      <Text variant="title1" accessibilityRole="header">
        {t('signIn.title')}
      </Text>

      <View style={{ gap: th.space.xs }}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel={tickLabel}
          accessibilityState={{
            checked: agreed,
            disabled: !ready,
            busy: saving,
          }}
          disabled={!ready}
          onPress={() => void toggle()}
          style={({ pressed }) => ({
            minHeight: 44 * scale,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: th.space.md,
            paddingVertical: th.space.sm,
            opacity: !ready ? 0.6 : pressed ? 0.85 : 1,
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
            {agreed ? (
              <Ionicons name="checkmark" size={18 * scale} color={th.colors.accentText} />
            ) : null}
          </View>
          <View style={{ flex: 1, gap: th.space.xs }}>
            <Text variant="callout">{signInLegalCopy.acknowledge}</Text>
            {legal.published ? <Text variant="callout">{signInLegalCopy.agree}</Text> : null}
          </View>
        </Pressable>
        {legal.published ? (
          <View style={{ paddingLeft: 24 * scale + th.space.md }}>
            <LegalLinks legal={legal} />
          </View>
        ) : null}
      </View>

      <View style={{ gap: th.space.md }}>
        {showApple ? (
          <Button
            label={t('signIn.apple')}
            variant="secondary"
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
          onSubmitEditing={canSend && !locked ? submit : undefined}
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
          loading={busy === 'email' || magic.state === 'sending'}
          disabled={!canSend || locked}
          accessibilityHint={lockedHint}
        />
      </View>

      {magic.state === 'sent' ? (
        <Text variant="callout" tone="accent" accessibilityLiveRegion="polite">
          {t('signIn.magicLinkSent')}
        </Text>
      ) : null}
      {error || magic.state === 'error' || magic.state === 'rate_limited' ? (
        <Text
          variant="callout"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {error ??
            (magic.state === 'rate_limited'
              ? signInLegalCopy.rateLimited
              : t('signIn.errorGeneric'))}
        </Text>
      ) : null}
    </Screen>
  );
}
