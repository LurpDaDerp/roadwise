import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { LicenseStage } from '../finish';
import { isLicenseStage, readLicense, saveLicense } from '../state';
import type { StepProps } from '../stepRegistry';
import { StepFrame } from '../StepFrame';

const copy = onboardingCopy.license;
const STAGES: readonly LicenseStage[] = ['permit', 'intermediate', 'full'];
const ICON: Record<LicenseStage, keyof typeof Ionicons.glyphMap> = {
  permit: 'school-outline',
  intermediate: 'car-outline',
  full: 'ribbon-outline',
};

/**
 * Learner's permit, intermediate or full. Kept on the phone (`onboarding.license`) until the last
 * step sends it with `complete_onboarding`, so a restart lands back here with it still picked.
 */
export function LicenseStep({ onNext, onBack }: StepProps) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const { profile } = useSession();
  const [stage, setStage] = useState<LicenseStage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void readLicense(settings)
      .catch(() => null)
      .then((saved) => {
        if (!live) return;
        const fromProfile = (profile as { license_stage?: unknown } | null)?.license_stage;
        setStage((s) => s ?? saved ?? (isLicenseStage(fromProfile) ? fromProfile : null));
      });
    return () => {
      live = false;
    };
  }, [settings, profile]);

  const next = async () => {
    if (!stage) return;
    setFailed(false);
    try {
      await saveLicense(settings, stage);
      onNext();
    } catch {
      setFailed(true);
    }
  };

  return (
    <StepFrame
      title={copy.title}
      body={copy.body}
      onBack={onBack}
      primary={{ label: copy.continue, onPress: () => void next(), disabled: stage === null, testID: 'license-continue' }}
      testID="license-step"
    >
      <View accessibilityRole="radiogroup" style={{ gap: th.space.md }}>
        {STAGES.map((s) => {
          const chosen = s === stage;
          return (
            <Pressable
              key={s}
              testID={`license-${s}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen }}
              accessibilityLabel={`${copy.options[s].title}. ${copy.options[s].body}`}
              onPress={() => setStage(s)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: th.space.md,
                minHeight: th.size.touchLg + th.space.md,
                padding: th.space.lg,
                borderRadius: th.radius.card,
                borderCurve: 'continuous',
                borderWidth: 2,
                borderColor: chosen ? th.colors.accent : th.colors.border,
                backgroundColor: chosen ? th.colors.accentFaint : pressed ? th.colors.surfaceRaised : th.colors.surface,
              })}
            >
              <Ionicons name={ICON[s]} size={th.size.iconLg} color={th.colors.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="headline">{copy.options[s].title}</Text>
                <Text variant="subhead" tone="muted">
                  {copy.options[s].body}
                </Text>
              </View>
              <Ionicons
                name={chosen ? 'checkmark-circle' : 'ellipse-outline'}
                size={th.size.iconLg}
                color={chosen ? th.colors.accent : th.colors.borderStrong}
              />
            </Pressable>
          );
        })}
      </View>
      {failed ? (
        <Text variant="callout" tone="danger" accessibilityRole="alert">
          {copy.saveFailed}
        </Text>
      ) : null}
    </StepFrame>
  );
}
