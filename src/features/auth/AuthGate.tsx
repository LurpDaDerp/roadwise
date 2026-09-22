import { usePathname, useRouter, useSegments, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useAppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { supabase } from '@/data/supabase/client';
import { recordConsent } from '@/data/supabase/profile';
import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import {
  ONBOARDING_PENDING_HREF_KEY,
  PERMISSION_CONSENT_VERSION,
  readPendingPermissionConsents,
  savePendingPermissionConsents,
  type PermissionConsentType,
} from '@/features/onboarding/state';

import {
  HOME,
  ONBOARDING_START,
  driveFacts,
  pendingHrefFor,
  profileGate,
  readPendingHref,
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
  /** Merges `patch` into the caller's own `profiles.flags` on the server (Task 2's RPC). */
  mergeFlags?: (patch: { disclaimerAcknowledged: string }) => Promise<unknown>;
  /** Records one A6–A8 permission consent (default: M0's `recordConsent`). */
  recordPermissionConsent?: (
    userId: string,
    consent: { type: PermissionConsentType; version: string }
  ) => Promise<unknown>;
}

/**
 * `merge_own_profile_flags` (Task 2, 0007): a server-side merge into the caller's own row, so a
 * concurrent flags write elsewhere is never overwritten (T17 review m2). The server accepts only
 * the allowlisted keys and derives the row from the caller's JWT.
 */
export async function mergeOwnProfileFlags(patch: { disclaimerAcknowledged: string }): Promise<unknown> {
  const { data, error } = await supabase.rpc('merge_own_profile_flags', { patch });
  if (error) throw error;
  return data;
}

/**
 * What the device holds from before sign-in, recorded on the account (once per signed-in session):
 * - a pending Terms and Privacy acceptance (Task 15's `flushPendingConsents`: only when published);
 * - the disclaimer acknowledged at sign-in (A3), merged into `profiles.flags` server-side
 *   (`merge_own_profile_flags`, never a read-modify-write) so the Terms step
 *   does not ask a second time (ruling T15). Only the current `DISCLAIMER_VERSION` is copied, and
 *   only when the account does not already hold it, so an older tick never downgrades the row.
 * - the A6–A8 permission consents a step could not send (offline) and `finishOnboarding` could not
 *   either (T14 review m2): only those held for THIS account, each sent once; what is sent is
 *   dropped from the owed record, what fails stays for the next session. A failure here is
 *   returned as `failure`, never thrown, so it cannot hold back the refresh a merged disclaimer
 *   needs (T14 r1 review n1).
 * All are attempted whatever happens to the others. A failed Terms or disclaimer write rejects,
 * after all ran.
 */
export async function flushSignedInConsents(
  deps: SignedInConsentDeps
): Promise<{ recorded: TermsType[]; disclaimerMerged: boolean; failure: unknown }> {
  const { db, settings, userId, legal, consentApi, mergeFlags = mergeOwnProfileFlags } = deps;
  let failure: unknown = null;
  /** A permission consent that could not be sent: reported, never thrown (T14 r1 review n1). */
  let consentFailure: unknown = null;

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
      // Only the one key goes up: the server merges it into whatever the row holds now.
      await mergeFlags({ disclaimerAcknowledged: DISCLAIMER_VERSION });
      disclaimerMerged = true;
    }
  } catch (error) {
    failure ??= error;
  }

  try {
    const owed = await readPendingPermissionConsents(settings, userId);
    if (owed.length > 0) {
      const record = deps.recordPermissionConsent ?? recordConsent;
      const left: PermissionConsentType[] = [];
      for (const type of owed) {
        try {
          await record(userId, { type, version: PERMISSION_CONSENT_VERSION });
        } catch (error) {
          left.push(type);
          consentFailure ??= error;
        }
      }
      await savePendingPermissionConsents(settings, userId, left);
    }
  } catch (error) {
    consentFailure ??= error;
  }

  if (failure !== null) throw failure;
  return { recorded, disclaimerMerged, failure: consentFailure };
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
  const userId = session?.user.id ?? null;

  // The deep link held while setup is owed, known here before the moment it is needed, so the
  // exit from onboarding below can use it without waiting on a read (T14 review, ruling 1). It is
  // bound to the account it was held for and used only under that account; a sign-out or any
  // change of account drops it (T14 r1 review m1), whatever becomes of this component.
  const held = useRef<{ uid: string; href: string } | null>(null);
  const holdFor = (href: string | null) => {
    held.current = href !== null && userId !== null ? { uid: userId, href } : null;
  };
  useEffect(() => {
    if (held.current && (status === 'signedOut' || held.current.uid !== userId)) held.current = null;
  }, [status, userId]);
  // The generated route types may not list the group yet; the gate compares plain strings.
  const inOnboarding = (segments as readonly string[])[0] === '(onboarding)';
  useEffect(() => {
    if (gate !== 'onboarding') return;
    let live = true;
    const uid = userId;
    void readPendingHref(settings).then((href) => {
      // A read never replaces a fresher hold made while it was out (or clears one).
      if (live && uid !== null && href !== null && held.current === null) held.current = { uid, href };
    });
    return () => {
      live = false;
    };
  }, [gate, settings, userId]);

  useEffect(() => {
    const to = resolveGate(status, gate, update, segments, { busy, mode, tripOpen });
    if (!to) return;
    // A deep link that arrived while setup is owed is held (allowlisted) and opened when
    // onboarding finishes, instead of Home.
    if (to === ONBOARDING_START) {
      const href = pendingHrefFor(pathname);
      if (href !== null) holdFor(href);
      void savePendingHref(settings, pathname).catch(() => {});
    }
    // Setup has just finished while the driver is still inside onboarding: the held link has one
    // owner, this gate, so a render landing between `finishOnboarding`'s refresh and its own
    // replace can't send the driver Home and lose it. Used once, then cleared; Home otherwise.
    if (to === HOME && gate === 'ready' && inOnboarding) {
      const mine = held.current;
      held.current = null;
      const href = mine !== null && status === 'signedIn' && mine.uid === userId ? mine.href : null;
      if (href !== null) void settings.remove(ONBOARDING_PENDING_HREF_KEY).catch(() => {});
      router.replace((href ?? HOME) as Href);
      return;
    }
    router.replace(to as Href);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `holdFor` reads `userId`, listed here
  }, [status, gate, update, segments, busy, mode, tripOpen, router, pathname, settings, inOnboarding, userId]);

  // Once per signed-in session, against the server's row (a cached row may be stale).
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
      .then(({ disclaimerMerged, failure }) => {
        // Owed permission consents that still fail are kept; the next change of profile (or the
        // next session) tries them again. They never hold back the refresh below.
        if (failure !== null && flushedFor.current === userId) flushedFor.current = null;
        return disclaimerMerged ? refreshProfile() : undefined;
      })
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
