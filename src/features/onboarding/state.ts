import type { SettingsRepo } from '@/data/db/settings';

import { isStepId, type StepId } from './flow';

/**
 * Where onboarding was left, on this device, for this owner. Every key lives in `settings`, which a
 * handover wipes with the rest of the previous driver's local state, so none needs an owner id.
 */
export const ONBOARDING_STEP_KEY = 'onboarding.step';
/** The steps the walk had counted at the saved step, so a resume keeps "Step n of total" (T11 m1). */
export const ONBOARDING_PLAN_KEY = 'onboarding.plan';
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

/** The steps counted for "Step n of total" when the step was saved, so a resume keeps the count. */
export async function readSavedPlan(settings: SettingsRepo): Promise<StepId[]> {
  const value = await settings.get<unknown>(ONBOARDING_PLAN_KEY);
  return Array.isArray(value) ? value.filter(isStepId) : [];
}

export async function savePlan(settings: SettingsRepo, plan: readonly StepId[]): Promise<void> {
  await settings.set(ONBOARDING_PLAN_KEY, plan);
}

export async function clearOnboardingState(settings: SettingsRepo): Promise<void> {
  await settings.remove(ONBOARDING_STEP_KEY);
  await settings.remove(ONBOARDING_PLAN_KEY);
  await settings.remove(ONBOARDING_PENDING_HREF_KEY);
}
