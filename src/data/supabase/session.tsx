import type { Session } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { supabase } from './client';
import { fetchProfile, type Profile } from './profile';

type Status = 'loading' | 'signedOut' | 'signedIn';

type Ctx = {
  status: Status;
  session: Session | null;
  profile: Profile | null;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
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

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<Status>('loading');
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
    let inFlight: { userId: string; promise: Promise<Profile> } | null = null;

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
        loadedUserId = null;
        loadedProfile = null;
        inFlight = null;
        setProfile(null);
        setStatus('signedOut');
        return;
      }

      const userId = next.user.id;
      if (userId !== loadedUserId) {
        // A different account: whatever profile is on screen belongs to someone else.
        loadedUserId = userId;
        loadedProfile = null;
        setProfile(null);
      } else if (loadedProfile) {
        // Same user, profile already in hand. TOKEN_REFRESHED, USER_UPDATED and a repeated
        // INITIAL_SESSION must not cost a round trip.
        setStatus('signedIn');
        return;
      }

      try {
        const row = await profileFor(userId);
        if (superseded()) return;
        loadedProfile = row;
        setProfile(row);
      } catch {
        if (superseded()) return;
        // The row can lag sign-up (the handle_new_user trigger races the first read), and a later
        // read can fail or time out. Only the first fetch for a user may leave the profile null;
        // after that the last known row stands, so a blip cannot bounce an onboarded user back
        // into onboarding.
      }

      if (superseded()) return;
      setStatus('signedIn');
    }

    // Deliberately not routed through profileFor: a refresh is asked for because the row is known
    // to have changed, so it must not join an older in-flight read.
    refreshRef.current = async () => {
      const userId = loadedUserId;
      if (!userId) return;
      const mine = generation;
      const row = await withTimeout(fetchProfile(userId));
      // A sign-out or an account switch while this was in flight makes the row someone else's.
      if (!active || generation !== mine || loadedUserId !== userId) return;
      loadedProfile = row;
      setProfile(row);
    };

    supabase.auth.getSession().then(
      ({ data }) => load(data.session),
      // An unreadable stored session (a reset Keychain, a corrupt blob) rejects here. Treat it as
      // signed out; leaving the app on 'loading' would strand it on the splash screen.
      () => load(null)
    );
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      void load(next as Session | null);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      status,
      session,
      profile,
      signOut: async () => {
        await supabase.auth.signOut();
      },
      refreshProfile: () => refreshRef.current(),
    }),
    [status, session, profile]
  );

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
