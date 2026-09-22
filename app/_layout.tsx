import { QueryClientProvider } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { flushBeforeSignOut } from '@/boot/bootstrap';
import { BootstrapFailed } from '@/boot/BootstrapFailed';
import { runtimeController } from '@/boot/controller';
import { readDeviceOwner } from '@/boot/device';
import { watchDeviceOwner } from '@/boot/ownerWatch';
import { SwitchingAccounts } from '@/boot/SwitchingAccounts';
import { DataProvider } from '@/data/queries';
import { supabase } from '@/data/supabase/client';
import { SessionProvider } from '@/data/supabase/session';
import { DriveProvider } from '@/drive/DriveProvider';
import { AuthGate } from '@/features/auth/AuthGate';
import { LockoutGate } from '@/features/drive/LockoutGate';
import { useSummaryNotificationRouting } from '@/features/drive/useSummaryNotificationRouting';
import { RestoreRetryProvider } from '@/features/home/HomeBanners';
import { ThemeProvider } from '@/ui';
import { FONT_WAIT_MS, shouldRender, useAppFonts } from '@/ui/fonts';

// Hold the splash until the licence faces are in memory: the first frame of RoadWise has to be
// printed in B612, not in the platform sans it would otherwise fall back to for one flash.
void SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash is already hidden (a fast reload). Nothing to hold.
});

// A drive summary that fires while the app is open still shows (U3). Quiet: a banner and the list,
// no sound. M4 refines this per notification kind.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const controller = runtimeController;

export default function RootLayout() {
  const { loaded, error } = useAppFonts();
  const [timedOut, setTimedOut] = useState(false);
  // The record: SQLite opened and migrated, the interrupted drive recovered or adopted, the drive
  // host started, the sync runner started (`src/boot/bootstrap.ts`). The controller owns it: the
  // same launch `index.ts` began eagerly (a background wake needs no screen to start the engine),
  // memoised per generation, and rebuilt on a handover (`src/boot/controller.ts`). A failure keeps
  // its error while a retry runs, so the retry can show its progress without blanking the screen.
  const state = useSyncExternalStore(controller.subscribe, controller.state);
  const runtime = state.runtime;

  useEffect(() => {
    void controller.ensureRuntime().catch(() => {
      // Shown from the controller's state, with its retry.
    });
  }, []);

  // A sign-in by someone other than this device's owner. The runtime cannot be cleaned in place —
  // the query cache holds the last driver's rows and the runner may be draining them — so the
  // whole thing is dropped and built again, and the new launch's `identity` stage wipes. An open
  // drive is ended first and queued under the previous owner, then removed by that wipe (M2 open
  // decision 2: the known trade, not a rescue). The old runtime leaves the tree at once
  // (`switching`), so nobody reads a row of it meanwhile.
  // The watch names the new driver, and the rebuild wipes on that uid with no session read: a slow
  // session can never make a handover mount the previous driver's database (H2 I-1 a).
  const handover = useCallback((uid: string) => {
    void controller.rebuild({ expectedUid: uid }).catch(() => {});
  }, []);

  // A face that never resolves — no network on a cold install, a corrupt cache — must cost the
  // driver one beat, not the app. After that the platform faces carry the first frame.
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), FONT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Bound to the runtime, so a rebuild replaces the watch with the new one's rather than stacking
  // a second: the cleanup unsubscribes before the next effect subscribes.
  useEffect(() => {
    if (runtime === null) return;
    return watchDeviceOwner(runtime.db, { supabase, onHandover: handover });
  }, [runtime, handover]);

  // §8.2 (final review I3; final-fix security I-1): only a real sign-in by this device's owner —
  // a `SIGNED_IN` event whose uid is the recorded owner (or a device nobody owns yet) — lets
  // auto-record follow the opt-in again. A token refresh, the initial session or any other event
  // never does, and the host ignores even `SIGNED_IN` while its sign-out is still in progress. A
  // different driver is a handover: the rebuild's new host decides from its own launch.
  useEffect(() => {
    if (runtime === null) return;
    let live = true;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        runtime.drive.signOutCompleted();
        return;
      }
      if (event !== 'SIGNED_IN' || !session) return;
      const uid = session.user.id;
      void readDeviceOwner(runtime.db)
        .then((owner) => {
          if (live && (owner === uid || owner === null)) return runtime.drive.signedInAgain();
        })
        .catch(() => {});
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [runtime]);

  const fontsReady = shouldRender({ loaded, error, timedOut });
  const ready =
    fontsReady && (runtime !== null || state.error !== null || state.status === 'switching');

  // The layout sits above `DriveProvider`, so the host is passed in. It routes a summary tap only
  // once the Stack below is mounted, and never into a drive under way.
  useSummaryNotificationRouting({ host: runtime?.drive ?? null, ready: ready && runtime !== null });

  // Sign-out sends the deletes this device still owes while the session can (D1 security M-1).
  const flush = useCallback(
    () =>
      runtime === null
        ? // Unknown is never zero (H2 M-1): the sign-out flow asks rather than assumes.
          Promise.reject(new Error('no runtime to flush'))
        : flushBeforeSignOut(runtime),
    [runtime]
  );
  // Sign-out ends and finalizes an open drive under this driver, then stops auto-record (I3).
  const recording = useMemo(
    () =>
      runtime === null
        ? undefined
        : { stop: () => runtime.drive.suspendForSignOut(), resume: () => runtime.drive.resumeAfterSignIn() },
    [runtime]
  );
  // Home's "Couldn't restore your drives — Retry": the restore now, throttle bypassed.
  const retryRestore = useCallback(
    () => controller.foregroundJobs()?.runNow() ?? Promise.resolve(false),
    []
  );

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  if (state.status === 'switching') {
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
              retrying={state.status === 'booting'}
              onRetry={() => void controller.ensureRuntime().catch(() => {})}
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
              <DriveProvider host={runtime.drive}>
                <SessionProvider flushBeforeSignOut={flush} recording={recording}>
                  <RestoreRetryProvider retry={retryRestore}>
                    <AuthGate>
                      {/* A lockout covers every route, native modals included (U2, rev1: I12). */}
                      <LockoutGate>
                        {/* Portrait everywhere; only the HUD route turns (rev1: I17, U2's layout). */}
                        <Stack screenOptions={{ headerShown: false, orientation: 'portrait' }}>
                          <Stack.Screen name="index" />
                          <Stack.Screen name="(auth)" />
                          <Stack.Screen name="(tabs)" />
                          <Stack.Screen name="(app)" />
                          <Stack.Screen name="auth/callback" />
                          {/* No swipe-back out of a drive: it is left through its own controls. */}
                          <Stack.Screen
                            name="drive"
                            options={{ gestureEnabled: false, presentation: 'fullScreenModal' }}
                          />
                        </Stack>
                      </LockoutGate>
                    </AuthGate>
                  </RestoreRetryProvider>
                </SessionProvider>
              </DriveProvider>
            </DataProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
