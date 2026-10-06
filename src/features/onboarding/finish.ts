/**
 * The end of onboarding: the account is marked onboarded (`complete_onboarding`), the driver lands
 * where they were going, and the setup's own local state is dropped.
 */
import type { Href } from 'expo-router';

import type { SettingsRepo } from '@/data/db/settings';
import { supabase } from '@/data/supabase/client';
import { exitHref, HOME, readPendingHref } from '@/features/auth/authGuard';
import { TERMS_VERSION } from '@/features/auth/legal';

import { clearOnboardingState } from './state';

export type LicenseStage = 'permit' | 'intermediate' | 'full';

export interface FinishDeps {
  settings: SettingsRepo;
  /** The signed-in account, from the verified session only. */
  userId: string | null;
  router: { replace(href: Href): void };
  /** The session's `refreshProfile`: the gate reads `onboarded_at` from the profile it holds. */
  refreshProfile(): Promise<void>;
  /** Default: the `complete_onboarding` RPC. */
  complete?: (licenseStage: LicenseStage, termsVersion: string) => Promise<unknown>;
}

/**
 * `complete_onboarding(p_license_stage, p_terms_version)`. Typed loosely on purpose: the database
 * (and its generated types) is being rebuilt.
 */
async function completeOnboardingRpc(licenseStage: LicenseStage, termsVersion: string): Promise<unknown> {
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc.call(supabase, 'complete_onboarding', {
    p_license_stage: licenseStage,
    p_terms_version: termsVersion,
  });
  if (error) throw error instanceof Error ? error : new Error('complete_onboarding failed');
  return data;
}

/**
 * Finish onboarding:
 *
 * 1. the server marks the account onboarded;
 * 2. the held deep link is read (allowlisted and held for this account), else Home is the target;
 * 3. the profile is refreshed, and the navigation is made in the same turn as the refresh settling,
 *    so the gate sees the ready profile and the target together and moves no one;
 * 4. the onboarding state (step, plan, held link) is cleared.
 *
 * Rejects when there is no session, the call fails or the refresh fails; nothing is navigated or
 * cleared then, so the step can say so and the driver can try again.
 */
export async function finishOnboarding(deps: FinishDeps, licenseStage: LicenseStage): Promise<void> {
  const { settings, userId, router } = deps;
  if (userId === null) throw new Error('finishOnboarding needs a signed-in account');

  await (deps.complete ?? completeOnboardingRpc)(licenseStage, TERMS_VERSION);
  const target = exitHref(await readPendingHref(settings, userId)) ?? HOME;

  await deps.refreshProfile();
  router.replace(target as Href);

  await clearOnboardingState(settings).catch(() => {
    // Left behind, these keys are never read again: the profile now says onboarded.
  });
}
