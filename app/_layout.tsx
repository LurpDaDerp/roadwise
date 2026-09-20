import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { bootstrapApp, type AppRuntime } from '@/boot/bootstrap';
import { BootstrapFailed } from '@/boot/BootstrapFailed';
import { watchDeviceOwner } from '@/boot/ownerWatch';
import { SwitchingAccounts } from '@/boot/SwitchingAccounts';
import { DataProvider } from '@/data/queries';
import { supabase } from '@/data/supabase/client';
import { SessionProvider } from '@/data/supabase/session';
import { AuthGate } from '@/features/auth/AuthGate';
import { ThemeProvider } from '@/ui';
import { FONT_WAIT_MS, shouldRender, useAppFonts } from '@/ui/fonts';

// Hold the splash until the licence faces are in memory: the first frame of RoadWise has to be
// printed in B612, not in the platform sans it would otherwise fall back to for one flash.
void SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash is already hidden (a fast reload). Nothing to hold.
});

export default function RootLayout() {
  const { loaded, error } = useAppFonts();
  const [timedOut, setTimedOut] = useState(false);
  // The record: SQLite opened and migrated, the interrupted drive recovered, the sync runner
  // started (`src/boot/bootstrap.ts`). A failure keeps the attempt it belongs to, so a retry can
  // show its progress without blanking the screen. The launch carries its own deadline
  // (`BOOTSTRAP_TIMEOUT_MS`), so a hang arrives here as a failure rather than as a held splash.
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [failed, setFailed] = useState<{ attempt: number; error: Error } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A sign-in by someone other than this device's owner. The runtime cannot be cleaned in place —
  // the query cache holds the last driver's rows and the runner may be draining them — so the
  // whole thing is dropped and built again, and the new launch's `identity` stage wipes. The old
  // runtime leaves the tree first, in the same render, so nobody reads a row of it meanwhile.
  const [switching, setSwitching] = useState(false);

  const handover = useCallback(() => {
    setSwitching(true);
    setRuntime(null);
    setFailed(null);
    setAttempt((n) => n + 1);
  }, []);

  // A face that never resolves — no network on a cold install, a corrupt cache — must cost the
  // driver one beat, not the app. After that the platform faces carry the first frame.
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), FONT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let live = true;
    let started: AppRuntime | null = null;
    bootstrapApp().then(
      (next) => {
        if (!live) {
          void next.stop();
          return;
        }
        started = next;
        setRuntime(next);
        setFailed(null);
        setSwitching(false);
      },
      (reason: unknown) => {
        if (!live) return;
        setSwitching(false);
        setFailed({
          attempt,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        });
      }
    );
    return () => {
      live = false;
      void started?.stop();
    };
  }, [attempt]);

  // Bound to the runtime, so a rebuild replaces the watch with the new one's rather than stacking
  // a second: the cleanup unsubscribes before the next effect subscribes.
  useEffect(() => {
    if (runtime === null) return;
    return watchDeviceOwner(runtime.db, { supabase, onHandover: handover });
  }, [runtime, handover]);

  const fontsReady = shouldRender({ loaded, error, timedOut });
  const ready = fontsReady && (runtime !== null || failed !== null || switching);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  if (switching) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <SwitchingAccounts />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (runtime === null) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <BootstrapFailed
              retrying={failed !== null && failed.attempt !== attempt}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={runtime.queryClient}>
            <DataProvider db={runtime.db}>
              <SessionProvider>
                <AuthGate>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="index" />
                    <Stack.Screen name="(auth)" />
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="(app)" />
                    <Stack.Screen name="auth/callback" />
                  </Stack>
                </AuthGate>
              </SessionProvider>
            </DataProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
