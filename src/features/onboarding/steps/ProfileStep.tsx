import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, useWindowDimensions, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { clean, NAME_MAX_CHARS, prefillName } from '@/features/auth/prefillName';
import { Banner, Skeleton, Text, useTheme } from '@/ui';

import { readAgeBand, readPrivateProfile, saveProfileBasics, setBirthDate, writeOnboardingZone } from '../api';
import { onboardingCopy } from '../copy';
import { onboardingHref, type DrivingStage } from '../flow';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';
import {
  BirthDateField,
  birthDateError,
  checkBirthDate,
  EMPTY_BIRTH_DATE,
  FieldLabel,
  type BirthDateParts,
} from './BirthDateField';
import { ConfirmBirthDateSheet } from './ConfirmBirthDateSheet';

const copy = onboardingCopy.profile;

type Stage = Exclude<DrivingStage, 'unknown'>;
/** A4's five chips, in the product spec's order. */
export const STAGE_CHOICES: readonly Stage[] = [
  'permit',
  'new',
  'developing',
  'experienced',
  'non_driver',
];

/**
 * The name the field starts with: the one already on the profile, else the sign-in provider's
 * (`prefillName`), else nothing. Both are cleaned the way the server cleans a name.
 */
export function initialName(
  profileName: string | null | undefined,
  user: Parameters<typeof prefillName>[0]
): string {
  const saved = typeof profileName === 'string' ? clean(profileName) : '';
  return saved !== '' ? saved : prefillName(user);
}

/** The birth date already on the account: unknown until read; a read that failed says so. */
type Existing =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'known'; birthDate: string | null };

/**
 * A4: first name, birth date and driving stage.
 *
 * The birth date is written once and never again (0001), so it is confirmed before it is sent:
 * Continue opens `ConfirmBirthDateSheet`, and only "Yes, that's right" calls `set_birth_date`.
 * The server derives the age band from it. Then:
 *   - **under 13**: nothing else is saved — not the name, not the stage — and the flow moves to
 *     the block screen (the server has already minimised the account);
 *   - otherwise the name and stage are saved and the flow moves on.
 * A birth date already on the account is shown read-only and not asked for again. Every failure
 * is answered inline, and Continue (or the sheet's button) tries again from where it stopped.
 */
export function ProfileStep({ onNext, onBack }: StepProps) {
  const th = useTheme();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const router = useRouter();
  const { session, profile, refreshProfile } = useSession();
  // Identity for server calls comes from the verified session only (T12 security M-2).
  const userId = session?.user.id ?? null;

  const [name, setName] = useState(() => initialName(profile?.display_name, session?.user));
  const [nameFocused, setNameFocused] = useState(false);
  const [date, setDate] = useState<BirthDateParts>(EMPTY_BIRTH_DATE);
  const [stage, setStage] = useState<Stage | null>(() => {
    const s = profile?.driving_stage;
    return STAGE_CHOICES.includes(s as Stage) ? (s as Stage) : null;
  });
  const [existing, setExisting] = useState<Existing>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Reads the account's birth date; the state it lands in is set only when the answer comes. */
  const readExisting = useCallback(() => {
    if (userId === null) return;
    readPrivateProfile(userId).then(
      ({ birthDate }) => {
        if (mounted.current) setExisting({ kind: 'known', birthDate });
      },
      () => {
        if (mounted.current) setExisting({ kind: 'failed' });
      }
    );
  }, [userId]);

  const loadExisting = useCallback(() => {
    setExisting({ kind: 'loading' });
    readExisting();
  }, [readExisting]);

  useEffect(() => {
    readExisting();
  }, [readExisting]);

  const fixed = existing.kind === 'known' ? existing.birthDate : null;
  const check = useMemo(() => checkBirthDate(date), [date]);
  const dateError = fixed
    ? null
    : (birthDateError(check) ?? (attempted && !check.ok ? copy.dateMissing : null));
  const cleanName = clean(name);
  const nameError = attempted && cleanName === '' ? copy.nameMissing : null;
  const stageError = attempted && stage === null ? copy.stageMissing : null;
  const ready =
    existing.kind === 'known' && cleanName !== '' && stage !== null && (fixed !== null || check.ok);

  /**
   * With the birth date on the account: read the band the server derived from it. Under 13, only
   * the session's profile is refreshed (so the flow can see the block) and nothing else is sent —
   * the server refuses a child's profile write, and the name and stage must not be kept anyway.
   * Otherwise the name and stage are saved and the flow moves on.
   */
  const proceed = async () => {
    if (userId === null || stage === null) return;
    const band = await readAgeBand(userId);
    if (band === 'u13') {
      await refreshProfile();
      if (mounted.current) router.replace(onboardingHref('not-eligible'));
      return;
    }
    await saveProfileBasics(userId, { displayName: cleanName, drivingStage: stage });
    await refreshProfile();
    if (mounted.current) onNext();
  };

  const onContinue = async () => {
    setAttempted(true);
    if (!ready || running.current) return;
    if (fixed === null) {
      // Write-once: the driver sees the date spelled out and says yes before anything is sent.
      setConfirmFailed(false);
      setConfirming(true);
      return;
    }
    running.current = true;
    setBusy(true);
    setSaveFailed(false);
    try {
      await proceed();
    } catch {
      if (mounted.current) setSaveFailed(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const onConfirm = async () => {
    if (userId === null || !check.ok || running.current) return;
    running.current = true;
    setBusy(true);
    setConfirmFailed(false);
    let stored: 'set' | 'already-set' | null = null;
    try {
      // The zone first, so the server derives the band on this driver's own date (backend m3); a
      // failure is ignored — the hourly band pass corrects it.
      await writeOnboardingZone(userId);
      // 'already-set' means the account already has one; that one counts, whatever was typed.
      stored = await setBirthDate(check.iso);
      await proceed();
    } catch {
      if (!mounted.current) return;
      if (stored) {
        // The birth date is on the account; what failed came after it. From here Continue picks
        // up without asking for the date again, and the step says what went wrong.
        setConfirming(false);
        setSaveFailed(true);
        // The account's own date is shown, never one the server did not keep.
        if (stored === 'set') setExisting({ kind: 'known', birthDate: check.iso });
        else loadExisting();
      } else {
        setConfirmFailed(true);
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <StepFrame
      title={copy.title}
      onBack={onBack}
      primary={{
        label: copy.continue,
        onPress: () => void onContinue(),
        disabled: existing.kind !== 'known',
        loading: busy && !confirming,
        testID: 'profile-continue',
      }}
    >
      <View style={{ gap: th.space.xl }}>
        <View style={{ gap: th.space.xs }}>
          <FieldLabel>{copy.nameLabel}</FieldLabel>
          <TextInput
            testID="profile-name"
            accessibilityLabel={copy.nameLabel}
            value={name}
            onChangeText={setName}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            maxLength={NAME_MAX_CHARS}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
            returnKeyType="next"
            selectionColor={th.colors.accent}
            cursorColor={th.colors.accent}
            allowFontScaling={false}
            style={{
              minHeight: 48 * scale,
              borderWidth: 1.5,
              borderColor: nameError
                ? th.colors.danger
                : nameFocused
                  ? th.colors.accent
                  : th.colors.borderStrong,
              borderRadius: th.radius.md,
              paddingHorizontal: th.space.md,
              backgroundColor: th.colors.surface,
              color: th.colors.text,
              fontSize: 17 * scale,
            }}
          />
          {nameError ? (
            <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
              {nameError}
            </Text>
          ) : null}
        </View>

        {existing.kind === 'loading' ? (
          <View style={{ gap: th.space.xs }} accessible accessibilityLabel={copy.birthDateLabel}>
            <FieldLabel>{copy.birthDateLabel}</FieldLabel>
            <Skeleton width="70%" height={48} radius={th.radius.md} />
          </View>
        ) : existing.kind === 'failed' ? (
          <Banner
            tone="danger"
            message={copy.loadFailed}
            action={{ label: copy.retry, onPress: loadExisting }}
            testID="profile-load-failed"
          />
        ) : (
          <BirthDateField
            value={date}
            onChange={setDate}
            fixed={fixed}
            error={dateError}
            editable={!busy}
          />
        )}

        <View style={{ gap: th.space.sm }}>
          <FieldLabel>{copy.stageLabel}</FieldLabel>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={copy.stageLabel}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm }}
          >
            {STAGE_CHOICES.map((choice) => {
              const on = stage === choice;
              return (
                <Pressable
                  key={choice}
                  testID={`stage-${choice}`}
                  accessibilityRole="radio"
                  accessibilityLabel={copy.stagesSpoken[choice]}
                  accessibilityState={{ checked: on, disabled: busy }}
                  disabled={busy}
                  onPress={() => setStage(choice)}
                  style={({ pressed }) => ({
                    minHeight: 44 * scale,
                    justifyContent: 'center',
                    paddingHorizontal: th.space.lg,
                    borderRadius: th.radius.pill,
                    borderWidth: 1.5,
                    borderColor: on ? th.colors.accent : th.colors.borderStrong,
                    backgroundColor: on
                      ? th.colors.accent
                      : pressed
                        ? th.colors.surfaceRaised
                        : th.colors.surface,
                  })}
                >
                  <Text variant="subhead" style={{ color: on ? th.colors.accentText : th.colors.text }}>
                    {copy.stages[choice]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {stageError ? (
            <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
              {stageError}
            </Text>
          ) : null}
        </View>

        {saveFailed ? (
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

      <ConfirmBirthDateSheet
        visible={confirming}
        iso={check.ok ? check.iso : null}
        busy={busy}
        failed={confirmFailed}
        onConfirm={() => void onConfirm()}
        onEdit={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </StepFrame>
  );
}
