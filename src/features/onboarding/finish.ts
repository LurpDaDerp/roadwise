/**
 * The end of onboarding (A12 → B1): the account is marked onboarded, the driver lands where they
 * were going, and the setup's own local state is dropped.
 */
import type { Href } from 'expo-router';

import type { SettingsRepo } from '@/data/db/settings';
import { supabase } from '@/data/supabase/client';
import { recordConsent } from '@/data/supabase/profile';
import { HOME, readPendingHref } from '@/features/auth/authGuard';
import { DRIVE_ROUTES, driveHref } from '@/features/drive/hudCopy';

import { CONSENTS_CACHE_KEY } from './context';
import {
  PERMISSION_CONSENT_VERSION,
  clearOnboardingState,
  readPendingPermissionConsents,
  savePendingPermissionConsents,
  type PermissionConsentType,
} from './state';

/** `flags.onboardingVersion`: which onboarding this account finished (0007 accepts 1–1000). */
export const ONBOARDING_VERSION = 1;

export interface OnboardedPatch {
  onboarded: true;
  onboardingVersion: number;
}

export interface FinishDeps {
  settings: SettingsRepo;
  /** The signed-in account, from the verified session only (T12 security M-2). */
  userId: string | null;
  router: { replace(href: Href): void; push(href: Href): void };
  /** The session's `refreshProfile`: the gate reads `flags.onboarded` from the profile it holds. */
  refreshProfile(): Promise<void>;
  /** Default: T2's `merge_own_profile_flags`, a server-side `flags || patch` on the caller's own row. */
  mergeFlags?: (patch: OnboardedPatch) => Promise<unknown>;
  /** Default: M0's `recordConsent`. Sends the permission consents a step could not. */
  recordConsent?: (userId: string, consent: { type: PermissionConsentType; version: string }) => Promise<unknown>;
}

async function mergeOwnFlags(patch: OnboardedPatch): Promise<unknown> {
  const { data, error } = await supabase.rpc('merge_own_profile_flags', { patch: { ...patch } });
  if (error) throw error;
  return data;
}

/**
 * Sends the A6–A8 consents recorded while offline, under the account that granted them only.
 * Best effort: one that still fails stays owed, and never holds the finish back.
 */
async function flushPermissionConsents(deps: FinishDeps, userId: string): Promise<void> {
  const record = deps.recordConsent ?? recordConsent;
  const owed = await readPendingPermissionConsents(deps.settings, userId);
  if (owed.length === 0) return;
  const left: PermissionConsentType[] = [];
  for (const type of owed) {
    try {
      await record(userId, { type, version: PERMISSION_CONSENT_VERSION });
    } catch {
      left.push(type);
    }
  }
  await savePendingPermissionConsents(deps.settings, userId, left);
}

/**
 * Finish onboarding:
 *
 * 1. the permission consents still owed are sent (best effort);
 * 2. `{ onboarded: true, onboardingVersion: 1 }` is merged into `profiles.flags` on the server;
 * 3. the held deep link is read (allowlisted and held for this account, `readPendingHref`), else
 *    Home is the target;
 * 4. the profile is refreshed, and the navigation is made **in the same turn** as the refresh
 *    settling — with nothing awaited between them;
 * 5. the onboarding state (step, plan, held link) and the Terms consents cache are cleared.
 *
 * Why step 4 is ordered that way (it departs from "navigate first, then refresh", T17 carry): the
 * gate sends anyone OUTSIDE onboarding back to `/(onboarding)/start` while the profile it holds
 * says setup is owed, and sends anyone INSIDE onboarding Home once it says ready. Navigating first
 * is bounced back into onboarding by the stale profile (re-holding the link, which the step-5
 * clear then drops); refreshing and letting a render happen first sends the driver Home. The
 * refresh sets the profile; the replace right after it is batched into the same render, so the
 * gate sees the ready profile and the target together and moves no one.
 *
 * `startDrive`: A12's "Start a drive now" — Home, with the drive start presented over it (the
 * driver chose to drive; a held link is dropped with the rest of the onboarding state).
 *
 * Rejects when there is no session, the merge fails or the refresh fails; nothing is navigated or
 * cleared then, so the Ready step can say so and the driver can try again (the merge is idempotent).
 */
export async function finishOnboarding(
  deps: FinishDeps,
  opts: { startDrive?: boolean } = {}
): Promise<void> {
  const { settings, userId, router } = deps;
  if (userId === null) throw new Error('finishOnboarding needs a signed-in account');

  await flushPermissionConsents(deps, userId).catch(() => {});
  await (deps.mergeFlags ?? mergeOwnFlags)({ onboarded: true, onboardingVersion: ONBOARDING_VERSION });

  const target = opts.startDrive ? HOME : ((await readPendingHref(settings, userId)) ?? HOME);

  await deps.refreshProfile();
  router.replace(target as Href);
  if (opts.startDrive) router.push(driveHref(DRIVE_ROUTES.start));

  try {
    await clearOnboardingState(settings);
    // Read only for `termsCurrent` while onboarding runs offline (T12 (3)); the gate never
    // returns an onboarded account to the flow, so nothing reads it after this.
    await settings.remove(CONSENTS_CACHE_KEY);
  } catch {
    // Left behind, these keys are never read again: the profile now says onboarded.
  }
}
