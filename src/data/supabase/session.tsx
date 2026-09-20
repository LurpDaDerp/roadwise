import type { Session } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

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

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let active = true;

    async function load(next: Session | null) {
      if (!active) return;
      setSession(next);
      if (!next) {
        setProfile(null);
        setStatus('signedOut');
        return;
      }
      try {
        const row = await fetchProfile(next.user.id);
        if (!active) return;
        setProfile(row);
      } catch {
        // The profile row can lag the sign-in (the handle_new_user trigger races the first read).
        // Signed in without a profile is a legitimate state; onboarding fills it in.
        if (!active) return;
        setProfile(null);
      }
      setStatus('signedIn');
    }

    void supabase.auth.getSession().then(({ data }) => load(data.session));
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
      refreshProfile: async () => {
        if (session) setProfile(await fetchProfile(session.user.id));
      },
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
