import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { callRpc } from '@/data/server/rpc';
import { useSession } from '@/data/supabase/session';
import { heldClanCode, readPendingHref } from '@/features/auth/authGuard';
import { isValidCode, normalizeCode } from '@/features/clan/model';
import { friendlyError } from '@/features/social/errors';
import { Card, Text, useFontScale, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import { finishOnboarding, type LicenseStage } from '../finish';
import { onboardingHref } from '../flow';
import { isLicenseStage, readLicense } from '../state';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.clan;

interface ClanPreview {
  name: string;
  banner: string;
  member_count: number;
  full: boolean;
}

/**
 * The optional last step: an invite code is previewed (`preview_clan`), then joined (`join_clan`),
 * or skipped. Either way setup finishes here (`finishOnboarding` → `complete_onboarding`) with the
 * license stage picked earlier, and the driver lands on Home.
 */
export function ClanStep({ onBack }: StepProps) {
  const th = useTheme();
  const scale = useFontScale();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { session, profile, refreshProfile } = useSession();
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<ClanPreview | null>(null);
  const [busy, setBusy] = useState<'find' | 'join' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An invite link tapped before setup was held by the gate: fill its code in, one tap to preview.
  const uid = session?.user.id ?? null;
  useEffect(() => {
    if (uid === null) return;
    let live = true;
    void readPendingHref(settings, uid).then((href) => {
      const held = heldClanCode(href);
      if (live && held !== null && isValidCode(held)) setCode((c) => (c === '' ? held : c));
    });
    return () => {
      live = false;
    };
  }, [settings, uid]);

  const finish = async (): Promise<void> => {
    const saved = await readLicense(settings).catch(() => null);
    const fromProfile = (profile as { license_stage?: unknown } | null)?.license_stage;
    const stage: LicenseStage | null = saved ?? (isLicenseStage(fromProfile) ? fromProfile : null);
    if (stage === null) {
      router.replace(onboardingHref('license'));
      return;
    }
    await finishOnboarding({ settings, userId: session?.user.id ?? null, router, refreshProfile }, stage);
  };

  const run = async (what: 'find' | 'join' | 'skip', work: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (e) {
      const finishFailed = what === 'skip' || (e instanceof Error && e.message === copy.finishFailed);
      setError(finishFailed ? copy.finishFailed : friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const find = () =>
    run('find', async () => {
      setPreview(await callRpc<ClanPreview>('preview_clan', { p_code: code }));
    });

  const join = () =>
    run('join', async () => {
      await callRpc<unknown>('join_clan', { p_code: code });
      try {
        await finish();
      } catch {
        // Joined; only the finish failed. Say that, and Skip finishes without joining twice.
        setPreview(null);
        throw new Error(copy.finishFailed);
      }
    });

  const skip = () => run('skip', finish);

  const canJoin = preview !== null && !preview.full;

  return (
    <StepFrame
      title={copy.title}
      body={copy.body}
      onBack={onBack}
      primary={
        canJoin
          ? { label: copy.join(preview.name), onPress: () => void join(), loading: busy === 'join', testID: 'clan-join' }
          : { label: copy.find, onPress: () => void find(), disabled: !isValidCode(code), loading: busy === 'find', testID: 'clan-find' }
      }
      secondary={{ label: copy.skip, onPress: () => void skip(), loading: busy === 'skip', disabled: busy !== null && busy !== 'skip', testID: 'clan-skip' }}
      testID="clan-step"
    >
      <View style={{ gap: th.space.md }}>
        <TextInput
          testID="clan-code"
          accessibilityLabel={copy.label}
          value={code}
          onChangeText={(t) => {
            setError(null);
            setPreview(null);
            setCode(normalizeCode(t).slice(0, 8));
          }}
          placeholder={copy.placeholder}
          placeholderTextColor={th.colors.textSubtle}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          allowFontScaling={false}
          style={{
            minHeight: 56 * scale,
            borderWidth: 2,
            borderColor: th.colors.borderStrong,
            borderRadius: th.radius.md,
            borderCurve: 'continuous',
            backgroundColor: th.colors.surface,
            color: th.colors.text,
            paddingHorizontal: th.space.lg,
            fontSize: 24 * scale,
            fontWeight: '700',
            letterSpacing: 4,
            textAlign: 'center',
          }}
        />
        {preview ? (
          <Card testID="clan-preview" style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: th.radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: th.colors.accentFaint,
              }}
            >
              <Ionicons name="shield" size={th.size.iconLg} color={th.colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title3">{preview.name}</Text>
              <Text variant="subhead" tone="muted">
                {copy.members(preview.member_count)}
              </Text>
            </View>
          </Card>
        ) : null}
        {preview?.full ? (
          <Text variant="callout" tone="danger" testID="clan-full">
            {copy.full}
          </Text>
        ) : null}
        {error ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert" testID="clan-error">
            {error}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
