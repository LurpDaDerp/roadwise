import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { flushBeforeSignOut, type AppRuntime } from '@/boot/bootstrap';
import { hasDriverData, readDeviceOwner, wipeForSignOut } from '@/boot/device';
import { BootstrapFailed } from '@/boot/BootstrapFailed';
import { runtimeController } from '@/boot/controller';
import { watchDeviceOwner } from '@/boot/ownerWatch';
import { SwitchingAccounts } from '@/boot/SwitchingAccounts';
import { DashpalPromptHost } from '@/dashcam/ui/PromptHost';
import { createSettingsRepo } from '@/data/db/settings';
import { DeviceHost } from '@/data/devices/DeviceHost';
import { readInstallId } from '@/data/devices/installId';
import { releaseDevice } from '@/data/devices/register';
import { callRpc } from '@/data/server/rpc';
import { DataProvider } from '@/data/queries';
import { supabase } from '@/data/supabase/client';
import { registerAfterSignOut, registerBeforeSignOut, SessionProvider } from '@/data/supabase/session';
import { setDisplayLook } from '@/drive/displayLook';
import { DriveProvider } from '@/drive/DriveProvider';
import { AuthGate } from '@/features/auth/AuthGate';
import { LockoutGate } from '@/features/drive/LockoutGate';
import { NotificationsHost } from '@/features/notifications';
import { syncNotificationPrefs } from '@/features/settings/notifications/sync';
import { ThemeProvider } from '@/ui';
import { appearance, useAppearance, type AppearanceChoice } from '@/ui/appearance';
import { lookFor } from '@/ui/sky/look';
import { plainBundle, skyBundle, type SkyMood } from '@/ui/sky/palette';
import { appSkyPorts } from '@/ui/sky/ports';
import { SkyChrome } from '@/ui/sky/SkyChrome';
import { useSkyMood } from '@/ui/sky/useSkyMood';
import { FONT_WAIT_MS, shouldRender, useAppFonts } from '@/ui/fonts';

// Hold the splash until the licence faces are in memory: the first frame of RoadWise has to be
// printed in B612, not in the platform sans it would otherwise fall back to for one flash.
void SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash is already hidden (a fast reload). Nothing to hold.
});

// Settings › Appearance is read behind the splash too, so the first frame already wears the
// driver's look (a failed or slow read gives Adaptive).
void appearance.load();

const controller = runtimeController;

/**
 * The theme every tree of the root wears, from the phone's Appearance choice: the sky (Adaptive),
 * a pinned static look (Light, Dark), or the static look for the phone's own scheme (System, which
 * also hands the keyboard, alerts and maps back to the phone's setting).
 */
function RootTheme({ choice, mood, children }: { choice: AppearanceChoice; mood: SkyMood; children: ReactNode }) {
  return (
    <ThemeProvider mood={choice === 'adaptive' ? mood : null} scheme={choice === 'light' || choice === 'dark' ? choice : undefined}>
      <SkyChrome followSystem={choice === 'system'} />
      {children}
    </ThemeProvider>
  );
}

/**
 * M4's runtime-bound hosts (Task 18), inside the data, query, drive and session providers:
 * - `DeviceHost`: the device row, the permission report and the push token; on each foreground it
 *   syncs the notification preferences (T7). No `subscribeDrive`: the runtime is the one drive-state
 *   reporter (T10 r2, H2).
 * - `NotificationsHost`: the app's only notification handler and response listener (rev1: C1).
 *   Foreground banners stay hidden for the whole of a drive, not only while recording (T5 review).
 *   U3's summary notifier stays attached by the runtime itself (bootstrap), not here. A tap on the
 *   iPhone's recording note opens the driving screen while the drive records; no tap starts a drive.
 */
function RuntimeHosts({ runtime, ready }: { runtime: AppRuntime; ready: boolean }) {
  const host = runtime.drive;
  const isBusy = useCallback(() => host.isBusy(), [host]);
  const subscribeBusy = useCallback((listener: () => void) => host.subscribe(() => listener()), [host]);
  const onForeground = useCallback(
    (userId: string) => syncNotificationPrefs(userId, { db: runtime.db }),
    [runtime]
  );
  return (
    <>
      <DeviceHost onForeground={onForeground} />
      <NotificationsHost isRecording={isBusy} isBusy={isBusy} subscribeBusy={subscribeBusy} ready={ready} />
    </>
  );
}

export default function RootLayout() {
  const { loaded, error } = useAppFonts();
  const { choice, loaded: appearanceLoaded } = useAppearance();
  // The sky the theme wears under Adaptive: the sun at the phone's last known position and the
  // weather there. Read behind the splash once the stored choice is known (the splash waits for it),
  // so the first frame already has it. Until then, and under a static look, it is off: no position
  // read and no weather request for the sky (the choice the store holds before its read is only
  // the default, not the driver's).
  const mood = useSkyMood(appSkyPorts, { enabled: appearanceLoaded && choice === 'adaptive' });
  // Under System, the phone's own scheme (the override is handed back, so this reads the phone's).
  const phoneScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const staticScheme = choice === 'light' || choice === 'dark' ? choice : phoneScheme;
  // The Live Activity and the Android drive notification wear the same look (`src/drive/displayLook.ts`),
  // from the moment the choice is known.
  useEffect(() => {
    if (!appearanceLoaded) return;
    setDisplayLook(lookFor(choice === 'adaptive' ? skyBundle(mood) : plainBundle(staticScheme)));
  }, [appearanceLoaded, choice, mood, staticScheme]);
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
  // A sign-in by the owner (or the first sign-in on an empty phone) keeps this runtime, so what a
  // launch would have done for them runs now: their drives are restored from the server (a fresh
  // install, or a sign-out that emptied the phone) and the uploads that waited for a session go,
  // without waiting for a relaunch or the next foreground.
  useEffect(() => {
    if (runtime === null) return;
    const onOwnerSignIn = () => {
      void controller.foregroundJobs()?.runNow();
      void runtime.runner.signedIn().catch(() => {});
    };
    return watchDeviceOwner(runtime.db, { supabase, onHandover: handover, onOwnerSignIn });
  }, [runtime, handover]);

  // A session end — the driver's sign-out, or one they did not start (a revoked or expired
  // token) — stops recording: an open drive is finalized under the owner first. A sign-in by this
  // device's owner (or the first sign-in on an empty phone) lets Start Drive work again in this
  // process: a host launched signed out refuses `start()` until told. Nothing here arms or starts
  // a drive — a drive begins only from the Start Drive tap (plan §1 decision 4). A different
  // driver is a handover: `watchDeviceOwner` rebuilds, and the new launch decides for itself.
  useEffect(() => {
    if (runtime === null) return;
    let live = true;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        void runtime.drive.sessionEnded().catch(() => {});
        return;
      }
      if (!session || (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION')) return;
      const uid = session.user.id;
      void (async () => {
        const owner = await readDeviceOwner(runtime.db);
        if (!live) return;
        if (owner === uid || (owner === null && !(await hasDriverData(runtime.db)))) {
          await runtime.drive.signedInAgain({ initial: event === 'INITIAL_SESSION' });
        }
      })().catch(() => {});
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [runtime]);

  // Before the session ends at sign-out (inside the sign-out's 2 s budget) the server forgets this
  // install's push token. Once it has really ended (never when Supabase could not end it, offline
  // with an expired token) and with nothing left to upload, the driver's drives and privacy zones
  // leave the phone. Both read what they need at task start and never hold the sign-out.
  useEffect(() => {
    if (runtime === null) return;
    const settings = createSettingsRepo(runtime.db);
    const offRelease = registerBeforeSignOut(async () => {
      const deviceId = await readInstallId(settings);
      await releaseDevice({ rpc: callRpc, settings, deviceId });
    });
    const offWipe = registerAfterSignOut(async () => {
      if ((await runtime.runner.owed()) === 0) await wipeForSignOut(runtime.db);
    });
    return () => {
      offRelease();
      offWipe();
    };
  }, [runtime]);

  const fontsReady = shouldRender({ loaded, error, timedOut });
  const ready =
    fontsReady &&
    appearanceLoaded &&
    (runtime !== null || state.error !== null || state.status === 'switching');

  // Sign-out drains what this device still owes while the session can.
  const flush = useCallback(
    () =>
      runtime === null
        ? // Unknown is never zero (H2 M-1): the sign-out flow asks rather than assumes.
          Promise.reject(new Error('no runtime to flush'))
        : flushBeforeSignOut(runtime),
    [runtime]
  );
  // Sign-out ends and finalizes an open drive under this driver.
  const recording = useMemo(
    () =>
      runtime === null
        ? undefined
        : {
            // Recording stops: the open drive is finalized under this driver first.
            stop: () => runtime.drive.suspendForSignOut(),
            resume: () => runtime.drive.resumeAfterSignIn(),
          },
    [runtime]
  );
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  if (state.status === 'switching') {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <RootTheme choice={choice} mood={mood}>
            <SwitchingAccounts />
          </RootTheme>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  if (runtime === null) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <RootTheme choice={choice} mood={mood}>
            <BootstrapFailed
              retrying={state.status === 'booting'}
              onRetry={() => void controller.ensureRuntime().catch(() => {})}
            />
          </RootTheme>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <RootTheme choice={choice} mood={mood}>
          <QueryClientProvider client={runtime.queryClient}>
            <DataProvider db={runtime.db}>
              <DriveProvider host={runtime.drive}>
                <SessionProvider flushBeforeSignOut={flush} recording={recording}>
                  <AuthGate>
                    {/* A lockout covers every route, native modals included (U2, rev1: I12). */}
                    <LockoutGate>
                      {/* Portrait everywhere; only the HUD route turns (rev1: I17, U2's layout). */}
                      <Stack screenOptions={{ headerShown: false, orientation: 'portrait' }}>
                        <Stack.Screen name="index" />
                        <Stack.Screen name="(auth)" />
                        <Stack.Screen name="(onboarding)" />
                        <Stack.Screen name="update-required" />
                        <Stack.Screen name="(tabs)" />
                        <Stack.Screen name="(app)" />
                        {/* No swipe-back out of a drive: it is left through its own controls. */}
                        <Stack.Screen
                          name="drive"
                          options={{ gestureEnabled: false, presentation: 'fullScreenModal' }}
                        />
                      </Stack>
                    </LockoutGate>
                  </AuthGate>
                  <RuntimeHosts runtime={runtime} ready={ready && runtime !== null} />
                  {/* DashPal: the found-nearby offer, a deferred box link, alerts off the HUD. */}
                  <DashpalPromptHost />
                </SessionProvider>
              </DriveProvider>
            </DataProvider>
          </QueryClientProvider>
        </RootTheme>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
