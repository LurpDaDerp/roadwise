import { useGlobalSearchParams, usePathname, useRouter, useSegments, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { useDrive, useDriveHost } from '@/drive/useDrive';
import { ONBOARDING_PENDING_HREF_KEY } from '@/features/onboarding/state';

import {
  HOME,
  ONBOARDING_START,
  driveFacts,
  exitHref,
  pendingHrefFor,
  profileGate,
  readPendingHref,
  resolveGate,
  savePendingHref,
} from './authGuard';
import { flushTermsAcceptance } from './pendingConsent';
import { useUpdateStatus } from './version';

/**
 * The route guard. `app/index.tsx` decides where a cold start lands; this watches the session,
 * the profile, the minimum version and the drive for the whole life of the app, and moves a driver
 * who is on the wrong screen (`resolveGate`). It never moves anyone while a drive is under way or
 * a drive screen is showing (rev1: I10); it answers once the drive goes idle.
 *
 * Also, once per signed-in session, it sends the sign-in attestation (`accept_terms`; a failure is
 * retried on the next change of profile or the next launch), and after an offline start it
 * re-reads the profile whenever the app comes back to the front, so the cached row is replaced by
 * the server's.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status, session, profile, profileSource, refreshProfile } = useSession();
  const segments = useSegments();
  const pathname = usePathname();
  // A clan invite lands on `/clan/join` with its code as a search param, a DashPal link on
  // `/dashpal` with its dashcam id: hold the whole link.
  const { code, d } = useGlobalSearchParams<{ code?: string; d?: string }>();
  const linkPath =
    pathname === '/clan/join' && typeof code === 'string' ? `${pathname}?code=${code}` : pathname === '/dashpal' && typeof d === 'string' ? `${pathname}?d=${d}` : pathname;
  const router = useRouter();
  const host = useDriveHost();
  const driveStatus = useDrive((s) => s.status);
  const { busy, tripOpen } = driveFacts({ status: driveStatus }, host.isBusy());
  const update = useUpdateStatus() ?? 'unknown';
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
  // Ready and outside onboarding: the finish has landed (normally `finishOnboarding`'s own
  // replace, in the same render as the refresh, so the consuming branch below never ran). The held
  // link is spent, so a later visit to an onboarding route can't replay it (T14 r2 review nit).
  // The stored key goes too, once per account — a remove is idempotent.
  const spentFor = useRef<string | null>(null);
  useEffect(() => {
    if (gate !== 'ready' || inOnboarding) return;
    held.current = null;
    if (userId !== null && spentFor.current !== userId) {
      spentFor.current = userId;
      void settings.remove(ONBOARDING_PENDING_HREF_KEY).catch(() => {});
    }
  }, [gate, inOnboarding, userId, settings]);
  useEffect(() => {
    if (gate !== 'onboarding') return;
    let live = true;
    const uid = userId;
    if (uid === null) return;
    void readPendingHref(settings, uid).then((href) => {
      // A read never replaces a fresher hold made while it was out (or clears one).
      if (live && uid !== null && href !== null && held.current === null) held.current = { uid, href };
    });
    return () => {
      live = false;
    };
  }, [gate, settings, userId]);

  useEffect(() => {
    const to = resolveGate(status, gate, update, segments, { busy, tripOpen });
    if (!to) return;
    // A deep link that arrived while setup is owed is held (allowlisted) and opened when
    // onboarding finishes, instead of Home.
    if (to === ONBOARDING_START) {
      const href = pendingHrefFor(linkPath);
      if (href !== null) holdFor(href);
      if (userId !== null) void savePendingHref(settings, linkPath, userId).catch(() => {});
    }
    // Setup has just finished while the driver is still inside onboarding: the held link has one
    // owner, this gate, so a render landing between `finishOnboarding`'s refresh and its own
    // replace can't send the driver Home and lose it. Used once, then cleared; Home otherwise.
    if (to === HOME && gate === 'ready' && inOnboarding) {
      const mine = held.current;
      held.current = null;
      const href = mine !== null && status === 'signedIn' && mine.uid === userId ? exitHref(mine.href) : null;
      if (href !== null) void settings.remove(ONBOARDING_PENDING_HREF_KEY).catch(() => {});
      router.replace((href ?? HOME) as Href);
      return;
    }
    router.replace(to as Href);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `holdFor` reads `userId`, listed here
  }, [status, gate, update, segments, busy, tripOpen, router, linkPath, settings, inOnboarding, userId]);

  // The sign-in attestation, once per signed-in session. A failure (offline, or the server is not
  // ready) is retried on the next change of profile, and on the next launch.
  const flushedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status === 'signedOut') flushedFor.current = null;
    if (status !== 'signedIn' || userId === null || profile === null) return;
    if (flushedFor.current === userId) return;
    flushedFor.current = userId;
    void flushTermsAcceptance(settings, userId).catch(() => {
      if (flushedFor.current === userId) flushedFor.current = null;
    });
  }, [status, userId, profile, settings]);

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
