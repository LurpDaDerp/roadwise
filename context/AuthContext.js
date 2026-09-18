// AuthContext — the signed-in Firebase user plus a live subscription to the
// users/{uid} profile document (username, points, streak, photo, group).
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, db } from '../utils/firebase';
import { getGroupIdForUser } from '../utils/firestore';
import { KEYS } from '../utils/storageKeys';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [onboarded, setOnboarded] = useState(null); // null = unknown
  // The group id lives in users/{uid}/private/info (it is the join code). Three-valued:
  // a string, null (confirmed no group) or undefined (not read yet / read failed).
  const [groupId, setGroupId] = useState(undefined);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setInitializing(false);
      if (!u) {
        setProfile(null);
        setProfileLoaded(false);
        setOnboarded(null);
        setGroupId(undefined);
      }
    });
    return () => unsub();
  }, []);

  // Profile subscription.
  useEffect(() => {
    if (!user?.uid) return undefined;
    setProfileLoaded(false);
    const unsub = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        setProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null);
        setProfileLoaded(true);
      },
      (err) => {
        console.warn('Profile subscription failed:', err);
        setProfileLoaded(true);
      }
    );
    return () => unsub();
  }, [user?.uid]);

  // Onboarding flag (per user per device).
  useEffect(() => {
    if (!user?.uid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(KEYS.onboarded(user.uid));
        if (!cancelled) setOnboarded(v === 'true');
      } catch {
        if (!cancelled) setOnboarded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const refreshGroupId = useCallback(async () => {
    if (!user?.uid) return undefined;
    const id = await getGroupIdForUser(user.uid);
    setGroupId(id);
    return id;
  }, [user?.uid]);

  // Optimistic update after create / join / leave (utils/groups.js has already committed).
  const setGroupIdLocal = useCallback((id) => setGroupId(id), []);

  useEffect(() => {
    if (user?.uid) refreshGroupId();
  }, [user?.uid, refreshGroupId]);

  const completeOnboarding = useCallback(async () => {
    if (!user?.uid) return;
    setOnboarded(true);
    try {
      await AsyncStorage.setItem(KEYS.onboarded(user.uid), 'true');
    } catch {}
  }, [user?.uid]);

  const resetOnboarding = useCallback(async () => {
    if (!user?.uid) return;
    setOnboarded(false);
    try {
      await AsyncStorage.removeItem(KEYS.onboarded(user.uid));
    } catch {}
  }, [user?.uid]);

  const value = useMemo(
    () => ({
      user,
      uid: user?.uid || null,
      initializing,
      profile,
      profileLoaded,
      username: profile?.username || null,
      points: Number(profile?.points) || 0,
      streak: Number(profile?.drivingStreak) || 0,
      groupId,
      refreshGroupId,
      setGroupIdLocal,
      photoURL: profile?.photoURL || null,
      onboarded,
      completeOnboarding,
      resetOnboarding,
    }),
    [user, initializing, profile, profileLoaded, groupId, refreshGroupId, setGroupIdLocal, onboarded, completeOnboarding, resetOnboarding]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used inside AuthProvider');
  return ctx;
}
