import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Share, StyleSheet, useWindowDimensions, View } from 'react-native';

import { fontFamilies, Text, useTheme } from '@/ui';

import {
  createGuardianInvite,
  GuardianInviteError,
  isNetworkFailure,
  readGuardianLink,
  type GuardianInvite,
  type GuardianLink,
} from '../api';
import { formatInviteExpiry, guardianShareMessage, onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';
import { FieldLabel } from './BirthDateField';

const copy = onboardingCopy.guardian;

type Busy = 'send' | 'check' | null;

/**
 * A5, the guardian invite (rev1: I6). **Dark in M4:** the flow lists this step only for a 13–17
 * account while `feature_flags.guardian_invites` is on, and M6 turns that on when a guardian can
 * redeem the code. With the flag off the step is simply absent — no teen sees it, and the server
 * refuses the invite anyway.
 *
 * - The explainer says only what this build backs (no "a guardian can see…" line).
 * - **Send invite** creates one invite and opens the share sheet with a message holding the code
 *   and its expiry, never a link. The code stays on screen, and sending again reshares that code:
 *   asking the server again would revoke it.
 * - The status line is the server's `guardian_link_state`, read once on arrival (and on "Check
 *   again" in required mode) — no polling.
 * - **I'll do this later** in `guardian_link_optional`; in `guardian_consent_required` there is no
 *   way on until a guardian is linked (product A5: "this screen becomes blocking"), which is why
 *   that mode must stay off until M6 ships redemption.
 */
export function GuardianStep({ ctx, onNext, onBack }: StepProps) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const [link, setLink] = useState<GuardianLink | null>(null);
  const [linkFailed, setLinkFailed] = useState(false);
  const [issued, setIssued] = useState<GuardianInvite | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  /**
   * Bumped whenever the screen learns the link state first-hand (a create, an already-linked
   * refusal, a read). A read started under an older number lands on nothing, so a slow arrival
   * read can never print "expired" under a code just issued (T13 review m2).
   */
  const epoch = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Read the server's link state into the status line, unless something newer has been learned
   * since the read began. A failed read is said, never guessed.
   */
  const refreshLink = useCallback((): Promise<void> => {
    const started = ++epoch.current;
    const land = (next: GuardianLink | null) => {
      if (!mounted.current || started !== epoch.current) return;
      if (next) setLink(next);
      setLinkFailed(next === null);
    };
    return readGuardianLink().then(land, () => land(null));
  }, []);

  /** A state the screen was told directly (a create, a refusal): it wins over any read in flight. */
  const learnLink = (next: GuardianLink) => {
    epoch.current += 1;
    setLink(next);
    setLinkFailed(false);
  };

  useEffect(() => {
    // Once on arrival, in the foreground; nothing polls.
    void refreshLink();
  }, [refreshLink]);

  const share = async (invite: GuardianInvite) => {
    try {
      await Share.share({
        message: guardianShareMessage(invite.code, formatInviteExpiry(invite.expiresAt)),
      });
    } catch {
      if (mounted.current) setError(copy.errors.shareFailed);
    }
  };

  const send = async () => {
    if (running.current) return;
    running.current = true;
    setBusy('send');
    setError(null);
    try {
      let invite = issued;
      if (invite === null) {
        try {
          invite = await createGuardianInvite();
        } catch (e) {
          if (!mounted.current) return;
          if (e instanceof GuardianInviteError && e.reason === 'already-linked') {
            // The server's answer is the link state: nothing to send, and the way on is Continue.
            learnLink({ status: 'linked', expiresAt: null });
          } else if (e instanceof GuardianInviteError && e.reason === 'rate-limited') {
            setError(copy.errors.rateLimited);
          } else if (e instanceof GuardianInviteError) {
            setError(copy.errors.notAvailable);
          } else {
            // Only a request that never arrived is the connection's fault (m4).
            setError(isNetworkFailure(e) ? copy.errors.offline : copy.errors.failed);
          }
          return;
        }
        if (!mounted.current) return;
        setIssued(invite);
        // The invite set the link to pending on the server; no second read is needed to say so.
        learnLink({ status: 'pending', expiresAt: invite.expiresAt });
      }
      await share(invite);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const checkAgain = async () => {
    if (running.current) return;
    running.current = true;
    setBusy('check');
    setError(null);
    await refreshLink();
    running.current = false;
    if (mounted.current) setBusy(null);
  };

  const linked = link?.status === 'linked';
  const required = ctx.minorConsentMode === 'guardian_consent_required';
  const outstanding = issued !== null || link?.status === 'pending';
  const replaces =
    issued === null &&
    (link?.status === 'pending' || link?.status === 'declined' || link?.status === 'expired');
  /** A code that still works is out there, and this screen no longer holds it (m1). */
  const replacesLive = issued === null && link?.status === 'pending';

  /** Over a live code, the tap confirms that the old code dies before anything is sent (m1). */
  const onSend = () => {
    if (!replacesLive) {
      void send();
      return;
    }
    Alert.alert(copy.confirmReplace.title, copy.confirmReplace.body, [
      { text: copy.confirmReplace.cancel, style: 'cancel' },
      { text: copy.confirmReplace.confirm, style: 'destructive', onPress: () => void send() },
    ]);
  };

  const primary = linked
    ? { label: copy.continue, onPress: onNext, testID: 'guardian-continue' }
    : {
        label: replaces ? copy.sendNew : copy.send,
        onPress: onSend,
        loading: busy === 'send',
        disabled: busy !== null,
        testID: 'guardian-send',
      };
  const secondary = linked
    ? undefined
    : required
      ? {
          label: copy.checkAgain,
          onPress: () => void checkAgain(),
          loading: busy === 'check',
          disabled: busy !== null,
          testID: 'guardian-check',
        }
      : outstanding
        ? { label: copy.continue, onPress: onNext, disabled: busy !== null, testID: 'guardian-continue' }
        : { label: copy.later, onPress: onNext, disabled: busy !== null, testID: 'guardian-later' };

  return (
    <StepFrame
      title={copy.title}
      body={copy.explainer}
      onBack={onBack}
      primary={primary}
      secondary={secondary}
      testID="guardian-step"
    >
      <View style={{ gap: th.space.lg }}>
        {issued && !linked ? (
          <View style={{ gap: th.space.xs }}>
            <FieldLabel>{copy.codeLabel}</FieldLabel>
            <View
              style={{
                borderBottomWidth: StyleSheet.hairlineWidth * 2,
                borderBottomColor: th.colors.border,
                paddingBottom: th.space.sm,
              }}
            >
              <Text
                variant="display"
                selectable
                accessibilityLabel={`${copy.codeLabel}: ${issued.code.split('').join(' ')}`}
                style={{
                  fontFamily: fontFamilies.numeralsBold,
                  letterSpacing: 4 * scale,
                  color: th.colors.accent,
                }}
                testID="guardian-code"
              >
                {issued.code}
              </Text>
            </View>
          </View>
        ) : null}
        <View accessibilityLiveRegion="polite" style={{ gap: th.space.sm }}>
          <StatusLine link={link} failed={linkFailed} />
          {replacesLive && !linkFailed ? (
            <Text variant="callout" tone="muted" testID="guardian-replace-note">
              {copy.replaceNote}
            </Text>
          ) : null}
          {error ? (
            <Text variant="callout" tone="danger" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
        </View>
      </View>
    </StepFrame>
  );
}

/** The server's link state in words, each with a drawn glyph so it never rests on colour alone. */
function StatusLine({ link, failed }: { link: GuardianLink | null; failed: boolean }) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const size = 20 * Math.min(fontScale, 2);

  let glyph: keyof typeof Ionicons.glyphMap;
  let ink: string;
  let words: string;
  if (failed) {
    glyph = 'cloud-offline-outline';
    ink = th.colors.textMuted;
    words = copy.status.loadFailed;
  } else if (link === null || link.status === 'none') {
    return null;
  } else if (link.status === 'pending') {
    glyph = 'time-outline';
    ink = th.colors.info;
    words = link.expiresAt
      ? copy.status.pending(formatInviteExpiry(link.expiresAt))
      : copy.status.pendingUndated;
  } else if (link.status === 'linked') {
    glyph = 'checkmark-circle';
    ink = th.colors.success;
    words = copy.status.linked;
  } else {
    glyph = 'alert-circle';
    ink = th.colors.warning;
    words = link.status === 'declined' ? copy.status.declined : copy.status.expired;
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: th.space.sm }}>
      <Ionicons
        name={glyph}
        size={size}
        color={ink}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Text variant="callout" style={{ flex: 1 }} testID="guardian-status">
        {words}
      </Text>
    </View>
  );
}
