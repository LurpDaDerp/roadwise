import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { OnboardingStepper } from '@/features/onboarding';
import { useFlowContext } from '@/features/onboarding/context';

/**
 * The one onboarding route: `/(onboarding)/<step>`, plus the pseudo-step `start`. The context
 * comes from the session's profile, and is null while it is still being read.
 */
export default function OnboardingStepRoute() {
  const params = useLocalSearchParams<{ step?: string | string[] }>();
  const step = typeof params.step === 'string' ? params.step : undefined;
  const ctx = useFlowContext();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  return <OnboardingStepper step={step} ctx={ctx} settings={settings} />;
}
