import { usePathname, useRouter, useSegments, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { updateOwnProfile, type ProfilePatch } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';

import {
  ONBOARDING_START,
  driveFacts,
  profileGate,
  resolveGate,
  savePendingHref,
} from './authGuard';
import { DISCLAIMER_VERSION, legalState, type LegalState } from './legal';
import {
  DISCLAIMER_ACK_KEY,
  flushPendingConsents,
  type ConsentApi,
  type TermsType,
} from './pendingConsent';
import { useUpdateStatus } from './version';

export interface SignedInConsentDeps {
  db: Db;
  settings: SettingsRepo;
  userId: string;
  legal: LegalState;
  /** The flags of the profile row just read from the server (never a cached row). */
  flags: unknown;
  consentApi?: ConsentApi;
  updateProfile?: (userId: string, patch: ProfilePatch) => Promise<unknown>;
}

/**
 * What the device holds from before sign-in, recorded on the account (once per signed-in session):
 * - a pending Terms and Privacy acceptance (Task 15's `flushPendingConsents`: only when published);
 * - the disclaimer acknowledged at sign-in (A3), merged into `profiles.flags` so the Terms step
 *   does not ask a second time (ruling T15). Only the current `DISCLAIMER_VERSION` is copied, and
 *   only when the account does not already hold it, so an older tick never downgrades the row.
 * Both are attempted whatever happens to the other; if either fails this rejects, after both ran.
 */
export async function flushSignedInConsents(
  deps: SignedInConsentDeps
): Promise<{ recorded: TermsType[]; disclaimerMerged: boolean }> {
  const { db, settings, userId, legal, consentApi, updateProfile = updateOwnProfile } = deps;
  let failure: unknown = null;

  let recorded: TermsType[] = [];
  try {
    ({ recorded } = await flushPendingConsents(db, userId, legal, consentApi));
  } catch (error) {
    failure = error;
  }

  let disclaimerMerged = false;
  try {
    const ack = await settings.get<unknown>(DISCLAIMER_ACK_KEY);
    const flags =
      typeof deps.flags === 'object' && deps.flags !== null && !Array.isArray(deps.flags)
        ? (deps.flags as Record<string, unknown>)
        : {};
    if (ack === DISCLAIMER_VERSION && flags.disclaimerAcknowledged !== DISCLAIMER_VERSION) {
      await updateProfile(userId, {
        flags: { ...flags, disclaimerAcknowledged: DISCLAIMER_VERSION } as ProfilePatch['flags'],
      });
      disclaimerMerged = true;
    }
  } catch (error) {
    failure ??= error;
  }

  if (failure !== null) throw failure;
  return { recorded, disclaimerMerged };
}

/**
 * The route guard. `app/index.tsx` decides where a cold start lands; this watches the session,
 * the profile, the minimum version and the drive for the whole life of the app, and moves a driver
 * who is on the wrong screen (`resolveGate`). It never moves anyone while a drive is under way or
 * a drive screen is showing (rev1: I10); it answers once the drive goes idle.
 *
 * Also, once per signed-in session, it records what the device holds from before sign-in
 * (`flushSignedInConsents`), and after an offline start it re-reads the profile whenever the app
 * comes back to the front, so the cached row is replaced by the server's.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, session, profile, profileSource, refreshProfile } = useSession();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();
  const host = useDriveHost();
  const snapshot = useDrive((s) => ({ status: s.status, mode: s.mode }));
  const { busy, mode, tripOpen } = driveFacts(snapshot, host.isBusy());
  const update = useUpdateStatus() ?? 'unknown';
  const { config, ready: configReady } = useAppConfig();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const gate = profileGate(profile);

  useEffect(() => {
    const to = resolveGate(status, gate, update, segments, { busy, mode, tripOpen });
    if (!to) return;
    // A deep link that arrived while setup is owed is held (allowlisted) and opened when
    // onboarding finishes, instead of Home.
    if (to === ONBOARDING_START) void savePendingHref(settings, pathname).catch(() => {});
    router.replace(to as Href);
  }, [status, gate, update, segments, busy, mode, tripOpen, router, pathname, settings]);

  // Once per signed-in session, against the server's row (a cached row may be stale).
  const userId = session?.user.id ?? null;
  const flushedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status === 'signedOut') flushedFor.current = null;
    if (status !== 'signedIn' || userId === null || !configReady) return;
    if (profileSource !== 'network' || profile === null) return;
    // The row must be this account's own, or nothing is written (T17 security M-2).
    if (profile.id !== userId) return;
    // The server refuses consent writes for an under-13 account, and there is nothing to record.
    if (gate === 'blocked') return;
    if (flushedFor.current === userId) return;
    flushedFor.current = userId;
    const legal = legalState(config);
    void flushSignedInConsents({ db, settings, userId, legal, flags: profile.flags })
      .then(({ disclaimerMerged }) => (disclaimerMerged ? refreshProfile() : undefined))
      .catch(() => {
        // Offline, or the server refused: the next change of profile tries again.
        if (flushedFor.current === userId) flushedFor.current = null;
      });
  }, [status, userId, configReady, config, profileSource, profile, gate, db, settings, refreshProfile]);

  // A profile served from the cache (offline start) is re-read on each return to the front, and
  // only then: no timer, nothing in the background.
  useEffect(() => {
    if (profileSource !== 'cache') return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshProfile().catch(() => {});
    });
    return () => subscription.remove();
  }, [profileSource, refreshProfile]);

  return <>{children}</>;
}
