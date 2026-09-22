import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { updateOwnProfile } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { DISCLAIMER_VERSION, legalState, type LegalState } from '@/features/auth/legal';
import { LegalLinks } from '@/features/auth/LegalLinks';
import { DISCLAIMER_ACK_KEY } from '@/features/auth/pendingConsent';
import { Text, useTheme } from '@/ui';

import { recordCurrentTerms } from '../api';
import { noteConsentsRecorded } from '../context';
import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.terms;

/** A tick counts only for what it was given to (the sign-in screen's rule, T16). */
const tickSubject = (legal: LegalState): string =>
  legal.published && legal.tos && legal.privacy
    ? `terms:${legal.tos.version}:${legal.privacy.version}:${DISCLAIMER_VERSION}`
    : `disclaimer:${DISCLAIMER_VERSION}`;

const asFlags = (flags: unknown): Record<string, unknown> =>
  typeof flags === 'object' && flags !== null && !Array.isArray(flags)
    ? (flags as Record<string, unknown>)
    : {};

/**
 * The Terms step (rev1: I7). It asks only for what exists:
 *
 * - **Published** (both documents have a URL and a version): the disclaimer, the links, and one
 *   unticked box whose label names both the disclaimer and the Terms and Privacy Policy. Continue
 *   records a `tos` and a `privacy` consent at the published versions (skipping any the account
 *   already holds) and acknowledges the disclaimer (T15 review I1).
 * - **Unpublished**: the disclaimer with its own box and nothing about Terms or Privacy. Continue
 *   acknowledges the disclaimer and records **no** consent; the step comes back once the
 *   documents are published.
 *
 * The acknowledgement is a preference, not a consent: `flags.disclaimerAcknowledged` at the
 * current `DISCLAIMER_VERSION`, which is what makes `termsCurrent` true (T11 carry). Every write
 * is idempotent, so a failure is answered in place and Continue simply tries again.
 */
export function TermsStep({ onNext, onBack }: StepProps) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const { session, profile, refreshProfile } = useSession();
  const { config, ready } = useAppConfig();
  const legal = useMemo(() => legalState(config), [config]);
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const queryClient = useQueryClient();

  const subject = tickSubject(legal);
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const ticked = tickedFor === subject;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const label = legal.published ? `${copy.acknowledge} ${copy.agree}` : copy.acknowledge;
  const userId = session?.user.id ?? profile?.id ?? null;

  const submit = async () => {
    if (!ticked || running.current || userId === null) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (legal.published) {
        await recordCurrentTerms(userId, legal);
        await noteConsentsRecorded(queryClient, settings, userId, legal);
      }
      // The device keeps the acknowledgement too, as the sign-in screen's tick does.
      await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
      const flags = asFlags(profile?.flags);
      if (flags.disclaimerAcknowledged !== DISCLAIMER_VERSION) {
        await updateOwnProfile(userId, {
          flags: { ...flags, disclaimerAcknowledged: DISCLAIMER_VERSION },
        });
      }
      await refreshProfile();
      onNext();
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title={copy.title}
      onBack={onBack}
      primary={{
        label: copy.continue,
        onPress: () => void submit(),
        disabled: !ticked || !ready,
        loading: busy,
        testID: 'terms-continue',
      }}
    >
      <View style={{ gap: th.space.sm }}>
        <Pressable
          testID="terms-tick"
          accessibilityRole="checkbox"
          accessibilityLabel={label}
          accessibilityState={{ checked: ticked, disabled: !ready || busy }}
          disabled={!ready || busy}
          onPress={() => {
            setFailed(false);
            setTickedFor(ticked ? null : subject);
          }}
          style={({ pressed }) => ({
            minHeight: 44 * scale,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: th.space.md,
            padding: th.space.md,
            borderRadius: th.radius.md,
            borderWidth: 1,
            borderColor: ticked ? th.colors.accent : th.colors.border,
            backgroundColor: pressed ? th.colors.surfaceRaised : th.colors.surface,
          })}
        >
          <View
            style={{
              width: 24 * scale,
              height: 24 * scale,
              marginTop: 1 * scale,
              borderRadius: th.radius.sm / 2,
              borderWidth: 2,
              borderColor: ticked ? th.colors.accent : th.colors.borderStrong,
              backgroundColor: ticked ? th.colors.accent : th.colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {ticked ? (
              <Ionicons name="checkmark" size={18 * scale} color={th.colors.accentText} />
            ) : null}
          </View>
          <View style={{ flex: 1, gap: th.space.xs }}>
            <Text variant="body">{copy.acknowledge}</Text>
            {legal.published ? <Text variant="body">{copy.agree}</Text> : null}
          </View>
        </Pressable>
        {legal.published ? (
          <View style={{ paddingLeft: th.space.md + 24 * scale + th.space.md }}>
            <LegalLinks legal={legal} />
          </View>
        ) : null}
        {failed ? (
          <Text
            variant="callout"
            tone="danger"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {copy.saveFailed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
