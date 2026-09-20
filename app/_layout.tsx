import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { bootstrapApp, type AppRuntime } from '@/app/bootstrap';
import { BootstrapFailed } from '@/app/BootstrapFailed';
import { DataProvider } from '@/data/queries';
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
  // started (`src/app/bootstrap.ts`). A failure keeps the attempt it belongs to, so a retry can
  // show its progress without blanking the screen.
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [failed, setFailed] = useState<{ attempt: number; error: Error } | null>(null);
  const [attempt, setAttempt] = useState(0);

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
          next.stop();
          return;
        }
        started = next;
        setRuntime(next);
        setFailed(null);
      },
      (reason: unknown) => {
        if (!live) return;
        setFailed({
          attempt,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        });
      }
    );
    return () => {
      live = false;
      started?.stop();
    };
  }, [attempt]);

  const fontsReady = shouldRender({ loaded, error, timedOut });
  const ready = fontsReady && (runtime !== null || failed !== null);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

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
