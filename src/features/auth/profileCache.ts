import type { SettingsRepo } from '@/data/db/settings';
import type { Profile } from '@/data/supabase/profile';

/**
 * The last profile row this device read, so a signed-in cold start with no network (a garage, a
 * plane) still knows the driver's age band and whether they finished onboarding, and lands on
 * Home rather than on a retry card (rev1: I11). It lives in `settings`, which a handover wipes with
 * the rest of the previous driver's local state, so it is per owner; the user id is stored beside
 * it and checked on every read as well, so a cache can never be served to anyone else.
 */
export const PROFILE_CACHE_KEY = 'profile.cache';

interface StoredProfile {
  userId: string;
  profile: Profile;
}

export async function writeProfileCache(settings: SettingsRepo, profile: Profile): Promise<void> {
  const stored: StoredProfile = { userId: profile.id, profile };
  await settings.set(PROFILE_CACHE_KEY, stored);
}

/** The cached row for `userId`, or null: none stored, another user's, or not a profile. Never rejects. */
export async function readProfileCache(
  settings: SettingsRepo,
  userId: string
): Promise<Profile | null> {
  let stored: unknown;
  try {
    stored = await settings.get<unknown>(PROFILE_CACHE_KEY);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const { userId: owner, profile } = stored as Partial<StoredProfile>;
  if (typeof owner !== 'string' || owner !== userId) return null;
  if (typeof profile !== 'object' || profile === null) return null;
  if ((profile as { id?: unknown }).id !== userId) return null;
  return profile;
}
