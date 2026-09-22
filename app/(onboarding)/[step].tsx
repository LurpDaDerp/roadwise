import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { Platform } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import {
  OnboardingStepper,
  asAgeBand,
  asDrivingStage,
  type FlowContext,
} from '@/features/onboarding';

/**
 * A stand-in for Task 12's `useFlowContext()`: the band and stage from the signed-in profile, and
 * the M4 defaults for everything the app config will supply (Terms owed and unpublished, guardian
 * invites off, auto-detect on). Null while there is no profile, which holds the stepper on its
 * skeleton.
 */
function useFlowContextStub(): FlowContext | null {
  const { profile } = useSession();
  const ageBand = profile ? asAgeBand(profile.age_band) : null;
  const drivingStage = profile ? asDrivingStage(profile.driving_stage) : null;
  return useMemo(
    () =>
      ageBand === null || drivingStage === null
        ? null
        : {
            platform: Platform.OS === 'ios' ? 'ios' : 'android',
            ageBand,
            drivingStage,
            termsCurrent: false,
            termsPublished: false,
            minorConsentMode: 'guardian_link_optional',
            features: { autoDetect: true, guardianInvites: false },
          },
    [ageBand, drivingStage]
  );
}

export default function OnboardingStepRoute() {
  const params = useLocalSearchParams<{ step?: string | string[] }>();
  const step = typeof params.step === 'string' ? params.step : undefined;
  const ctx = useFlowContextStub();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  return <OnboardingStepper step={step} ctx={ctx} settings={settings} />;
}
