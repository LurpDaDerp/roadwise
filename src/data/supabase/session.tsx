import type { Session } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { bindPendingTerms, clearTermsAccepted } from '@/features/auth/pendingConsent';
import { readProfileCache, writeProfileCache } from '@/features/auth/profileCache';
import { cancelDriveSummaries } from '@/features/drive/summaryNotifier';

import { supabase } from './client';
import { fetchProfile, type Profile } from './profile';

type Status = 'loading' | 'signedOut' | 'signedIn';

/** What a sign-out flush achieved: the runner's `FlushResult` (`src/data/sync/runner.ts`). */
export type SignOutFlushResult = { sent: number; left: number };

/**
 * `signedOut: false` means nothing was ended: the flush left deletes unsent (`unsentDeletes`, or
 * `null` when the flush itself failed and the count is unknown). The caller names that to the
 * driver and, if they still want to, calls `signOut({ force: true })`.
 */
export type SignOutOutcome = { signedOut: true } | { signedOut: false; unsentDeletes: number | null };

/**
 * Where `profile` came from: this session's read of the server, or the device's cache of the last
 * read for the same user, served when the read failed or timed out (rev1: I11). Null while there
 * is no profile at all — which, signed in, now means only a first launch with no cache.
 */
export type ProfileSource = 'network' | 'cache' | null;

/** Work that must run while the session is still valid, just before it ends (Task 18: the push token). */
export type BeforeSignOutTask = () => Promise<unknown> | unknown;

/**
 * The whole of the time every before-sign-out task gets, together. A task still running then is
 * left behind (it may finish on its own) and the sign-out goes on: a hung request must never keep
 * a driver signed in.
 */
export const BEFORE_SIGN_OUT_BUDGET_MS = 2_000;

const beforeSignOut = new Set<BeforeSignOutTask>();

/**
 * Registers `task` to run on every sign-out the driver goes through with, after the drive has
 * been stopped and the deletes sent, before `supabase.auth.signOut()`. Returns the unregister.
 * Tasks run together under one 2-second budget; one that throws, rejects or hangs costs the others
 * nothing. Registering the same function twice runs it once.
 */
export function registerBeforeSignOut(task: BeforeSignOutTask): () => void {
  beforeSignOut.add(task);
  return () => {
    beforeSignOut.delete(task);
  };
}

async function runBeforeSignOut(budgetMs: number = BEFORE_SIGN_OUT_BUDGET_MS): Promise<void> {
  const tasks = [...beforeSignOut];
  if (tasks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  // Each task is wrapped, so a synchronous throw is a rejection like any other.
  const all = Promise.allSettled(
    tasks.map(async (task) => {
      await task();
    })
  );
  try {
    await Promise.race([all, budget]);
  } finally {
    clearTimeout(timer);
  }
}

type Ctx = {
  status: Status;
  session: Session | null;
  profile: Profile | null;
  profileSource: ProfileSource;
  /**
   * Sends every delete this device still owes (security review D1 M-1), then ends the session —
   * unless a delete could not be sent, in which case nothing is ended and the outcome says how
   * many. `force` skips the flush: the driver has just been told and chose to sign out anyway.
   */
  signOut: (opts?: { force?: boolean }) => Promise<SignOutOutcome>;
  /**
   * Reads the profile again (a step has just written it). Rejects when the read fails; a failure
   * leaves the profile on screen as it was.
   */
  refreshProfile: () => Promise<void>;
  registerBeforeSignOut: typeof registerBeforeSignOut;
};

const SessionCtx = createContext<Ctx | null>(null);

/**
 * A request that never settles would otherwise pin the app to 'loading' for the life of the
 * process, and every later auth event would join the same hung promise.
 */
const PROFILE_TIMEOUT_MS = 10_000;

function withTimeout(promise: Promise<Profile>): Promise<Profile> {
  return new Promise<Profile>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => reject(new Error('Timed out reading the profile')),
      PROFILE_TIMEOUT_MS
    );
    promise.then(
      (row) => {
        clearTimeout(timer);
        resolve(row);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Could not read the profile'));
      }
    );
  });
}

export function SessionProvider({
  children,
  flushBeforeSignOut,
  recording,
}: {
  children: React.ReactNode;
  /**
   * `() => flushBeforeSignOut(runtime)` from `src/boot/bootstrap.ts`, wired by the root layout.
   * It must run while the outgoing session is still valid: once a different driver signs in, the
   * wipe removes any delete still queued and the next restore would bring those drives back.
   * Absent (a tree with no runtime), sign-out ends the session directly, as before M3.
   */
  flushBeforeSignOut?: () => Promise<SignOutFlushResult>;
  /**
   * The drive host's sign-out hooks, wired by the root layout (§8.2 "Sign out: stops recording";
   * final review I3). `stop` ends and finalizes an open drive under the driver who is still signed
   * in, then disarms auto-record; `resume` undoes the disarm when the driver backs out of the
   * sign-out. Absent (no runtime), sign-out does not touch recording.
   */
  recording?: { stop(): Promise<void>; resume(): Promise<void> };
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileSource, setProfileSource] = useState<ProfileSource>(null);
  const [status, setStatus] = useState<Status>('loading');
  // The device's settings, through the data context this provider sits inside: the profile cache,
  // and the pending Terms acceptance a sign-out clears.
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  // The effect owns the bookkeeping that decides whether a write is still current; refreshProfile
  // has to go through the same gate, so it reaches it through this ref.
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let active = true;
    // Auth events overlap: a TOKEN_REFRESHED can land while the profile fetch for the previous one
    // is still out, and a SIGNED_OUT can land after both. Only the newest load may write state.
    let generation = 0;
    let loadedUserId: string | null = null;
    let loadedProfile: Profile | null = null;
    let loadedFromCache = false;
    let inFlight: { userId: string; promise: Promise<Profile> } | null = null;
    // Which account is on screen: bumped only when the user changes or signs out, never by a
    // same-user TOKEN_REFRESHED, so a refresh for the same user survives token churn (M0 T7).
    let account = 0;
    // Every read is ticketed when it starts; a row is written only if no later-started read has
    // been written already, so overlapping reads cannot put an older row back on screen.
    let ticket = 0;
    let appliedTicket = 0;

    function apply(row: Profile, mine: number) {
      if (mine < appliedTicket) return;
      appliedTicket = mine;
      loadedProfile = row;
      loadedFromCache = false;
      setProfile(row);
      setProfileSource('network');
      // The cache follows every successful read. A failed write costs only the offline start.
      void writeProfileCache(settings, row).catch(() => {});
    }

    // getSession() and the INITIAL_SESSION event both arrive on mount; share one request rather
    // than asking the server for the same row twice.
    function profileFor(userId: string): Promise<Profile> {
      if (inFlight?.userId === userId) return inFlight.promise;
      const promise = withTimeout(fetchProfile(userId));
      const clear = () => {
        if (inFlight?.promise === promise) inFlight = null;
      };
      inFlight = { userId, promise };
      promise.then(clear, clear);
      return promise;
    }

    async function load(next: Session | null) {
      generation += 1;
      const mine = generation;
      const superseded = () => !active || generation !== mine;

      setSession(next);

      if (!next) {
        account += 1;
        loadedUserId = null;
        loadedProfile = null;
        inFlight = null;
        setProfile(null);
        setProfileSource(null);
        setStatus('signedOut');
        return;
      }

      const userId = next.user.id;
      if (userId !== loadedUserId) {
        // A different account: whatever profile is on screen belongs to someone else.
        account += 1;
        loadedUserId = userId;
        loadedProfile = null;
        setProfile(null);
        setProfileSource(null);
      } else if (loadedProfile && !loadedFromCache) {
        // Same user, profile already in hand. TOKEN_REFRESHED, USER_UPDATED and a repeated
        // INITIAL_SESSION must not cost a round trip.
        setStatus('signedIn');
        return;
      } else if (loadedProfile) {
        // Same user, but only the cached row is in hand: the cache stays on screen while the
        // next event tries the server again.
        setStatus('signedIn');
      }

      // A Terms tick waiting for its sign-in becomes this account's, and only this account's
      // (T17 security M-1).
      void bindPendingTerms(settings, userId);

      ticket += 1;
      const mineTicket = ticket;
      // Started before the cache is read, so the cache costs the server read nothing.
      const read = profileFor(userId);

      // The device's cache of the last read for this same user goes on screen at once (rev1: I11,
      // T17 m1), so a cold start is as fast offline — failing or hanging — as online; the server
      // row replaces it when it lands. Only a first launch with no cache waits with no profile.
      if (!loadedProfile) {
        const cached = await readProfileCache(settings, userId);
        if (superseded()) return;
        if (cached && !loadedProfile && loadedUserId === userId) {
          loadedProfile = cached;
          loadedFromCache = true;
          setProfile(cached);
          setProfileSource('cache');
          setStatus('signedIn');
        }
      }

      try {
        const row = await read;
        if (superseded()) return;
        apply(row, mineTicket);
      } catch {
        if (superseded()) return;
        // The row can lag sign-up (the handle_new_user trigger races the first read), and a later
        // read can fail or time out. The last known row — the server's, or the cache's — stands,
        // so a blip cannot bounce an onboarded user back into onboarding.
      }

      if (superseded()) return;
      setStatus('signedIn');
    }

    // Deliberately not routed through profileFor: a refresh is asked for because the row is known
    // to have changed, so it must not join an older in-flight read.
    refreshRef.current = async () => {
      const userId = loadedUserId;
      if (!userId) return;
      const mine = account;
      ticket += 1;
      const mineTicket = ticket;
      const row = await withTimeout(fetchProfile(userId));
      // A sign-out or an account switch while this was in flight makes the row someone else's. A
      // token refresh for the same user does not (M0 T7: it used to drop the refresh).
      if (!active || account !== mine || loadedUserId !== userId) return;
      apply(row, mineTicket);
    };

    supabase.auth.getSession().then(
      ({ data }) => load(data.session),
      // An unreadable stored session (a reset Keychain, a corrupt blob) rejects here. Treat it as
      // signed out; leaving the app on 'loading' would strand it on the splash screen.
      () => load(null)
    );
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // Every end of a session — the driver's own sign-out, a revoked or expired one — forgets a
      // Terms tick not yet recorded (T17 security M-1). Only the event: a launch that simply
      // starts signed out keeps a tick made on the sign-in screen for the link it is waiting on.
      if (event === 'SIGNED_OUT') void clearTermsAccepted(settings).catch(() => {});
      void load(next as Session | null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [settings]);

  const value = useMemo<Ctx>(
    () => ({
      status,
      session,
      profile,
      profileSource,
      signOut: async (opts?: { force?: boolean }): Promise<SignOutOutcome> => {
        // First, while this driver is still signed in: an open drive is ended and finalized under
        // them, and auto-record stops (I3). A stop that fails does not hold the sign-out — the host
        // marked itself signed out before anything else, and the next launch starts disarmed.
        try {
          await recording?.stop();
        } catch {
          // Reported by the host; the session still ends.
        }
        if (flushBeforeSignOut && !opts?.force) {
          let left: number | null;
          try {
            ({ left } = await flushBeforeSignOut());
          } catch {
            // The flush could not say what it sent. Unknown is not zero: ask rather than assume.
            left = null;
          }
          if (left !== 0) {
            // The driver may still back out: they are signed in, so recording arms again.
            await recording?.resume().catch(() => {});
            return { signedOut: false, unsentDeletes: left };
          }
        }
        // Still signed in: whatever must reach the server under this session goes now (the push
        // token), all of it inside one 2-second budget, none of it able to hold the sign-out.
        await runBeforeSignOut();
        await supabase.auth.signOut();
        // A summary scheduled for this driver's last drive must not fire once they have left (U3).
        void cancelDriveSummaries().catch(() => {});
        // A Terms acceptance ticked on this device and not yet recorded belongs to the driver who
        // ticked it; the next sign-in ticks for itself (T15 r2).
        void clearTermsAccepted(settings).catch(() => {});
        return { signedOut: true };
      },
      refreshProfile: () => refreshRef.current(),
      registerBeforeSignOut,
    }),
    [status, session, profile, profileSource, flushBeforeSignOut, recording, settings]
  );

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
