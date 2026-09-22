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

// ---------------------------------------------------------------------------------------------
// A6–A8: the permission consents (`location`, `motion`, `notifications`) the steps record on a
// grant. One the server did not take (offline) waits here, bound to the account it was given by,
// and `finishOnboarding` sends it — never under another account.
// ---------------------------------------------------------------------------------------------

/**
 * The version a permission consent records: the A6–A8 primer wording the driver agreed under.
 * Bump it whenever that wording changes what it says about the use.
 */
export const PERMISSION_CONSENT_VERSION = 'primer-1';

export type PermissionConsentType = 'location' | 'motion' | 'notifications';
const CONSENT_TYPES: readonly PermissionConsentType[] = ['location', 'motion', 'notifications'];

/** Settings key: `{ userId, types }`, the grants whose consent is still owed to the server. */
export const PENDING_PERMISSION_CONSENTS_KEY = 'onboarding.pendingPermissionConsents';

export interface PendingPermissionConsents {
  userId: string;
  types: PermissionConsentType[];
}

/** What is owed for `userId`: another account's record, or a malformed one, reads as nothing. */
export async function readPendingPermissionConsents(
  settings: SettingsRepo,
  userId: string
): Promise<PermissionConsentType[]> {
  const raw = await settings.get<unknown>(PENDING_PERMISSION_CONSENTS_KEY);
  if (raw === null || typeof raw !== 'object') return [];
  const { userId: owner, types } = raw as Record<string, unknown>;
  if (owner !== userId || !Array.isArray(types)) return [];
  return CONSENT_TYPES.filter((t) => types.includes(t));
}

/** Adds `type` to what `userId` owes. A record held for another account is replaced. */
export async function addPendingPermissionConsent(
  settings: SettingsRepo,
  userId: string,
  type: PermissionConsentType
): Promise<void> {
  const held = await readPendingPermissionConsents(settings, userId);
  const types = held.includes(type) ? held : [...held, type];
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId, types } satisfies PendingPermissionConsents);
}

/** Writes what is still owed after a flush; nothing owed removes the key. */
export async function savePendingPermissionConsents(
  settings: SettingsRepo,
  userId: string,
  types: readonly PermissionConsentType[]
): Promise<void> {
  if (types.length === 0) {
    await settings.remove(PENDING_PERMISSION_CONSENTS_KEY);
    return;
  }
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId, types: [...types] } satisfies PendingPermissionConsents);
}

export async function clearOnboardingState(settings: SettingsRepo): Promise<void> {
  await settings.remove(ONBOARDING_STEP_KEY);
  await settings.remove(ONBOARDING_PLAN_KEY);
  await settings.remove(ONBOARDING_PENDING_HREF_KEY);
}
