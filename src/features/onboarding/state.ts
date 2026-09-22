import type { SettingsRepo } from '@/data/db/settings';

import { isStepId, type StepId } from './flow';

/**
 * Where onboarding was left, on this device, for this owner. Both keys live in `settings`, which a
 * handover wipes with the rest of the previous driver's local state, so neither needs an owner id.
 */
export const ONBOARDING_STEP_KEY = 'onboarding.step';
/**
 * A deep link that arrived while onboarding was still owed (Task 17 stores it, allowlisted);
 * `finishOnboarding` (Task 14) opens it instead of Home.
 */
export const ONBOARDING_PENDING_HREF_KEY = 'onboarding.pendingHref';

/** The last step shown, or null. A value this build does not know (a retired step) reads as none. */
export async function readSavedStep(settings: SettingsRepo): Promise<StepId | null> {
  const value = await settings.get<unknown>(ONBOARDING_STEP_KEY);
  return isStepId(value) ? value : null;
}

export async function saveStep(settings: SettingsRepo, step: StepId): Promise<void> {
  await settings.set(ONBOARDING_STEP_KEY, step);
}

export async function clearOnboardingState(settings: SettingsRepo): Promise<void> {
  await settings.remove(ONBOARDING_STEP_KEY);
  await settings.remove(ONBOARDING_PENDING_HREF_KEY);
}
