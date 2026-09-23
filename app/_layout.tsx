import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { flushBeforeSignOut, type AppRuntime } from '@/boot/bootstrap';
import { BootstrapFailed } from '@/boot/BootstrapFailed';
import { runtimeController } from '@/boot/controller';
import { hasDriverData, readDeviceOwner } from '@/boot/device';
import { watchDeviceOwner } from '@/boot/ownerWatch';
import { SwitchingAccounts } from '@/boot/SwitchingAccounts';
import { createSettingsRepo } from '@/data/db/settings';
import { DeviceHost } from '@/data/devices/DeviceHost';
import { unregisterPushToken } from '@/data/devices/pushToken';
import { DataProvider } from '@/data/queries';
import { supabase } from '@/data/supabase/client';
import { registerBeforeSignOut, SessionProvider, useSession } from '@/data/supabase/session';
import { DriveProvider } from '@/drive/DriveProvider';
import { AuthGate } from '@/features/auth/AuthGate';
import { LockoutGate } from '@/features/drive/LockoutGate';
import { RestoreRetryProvider } from '@/features/home/HomeBanners';
import { NotificationsHost } from '@/features/notifications';
import { PermissionPromptsHost } from '@/features/permissions/PermissionPromptsHost';
import { syncNotificationPrefs } from '@/features/settings/notifications/sync';
import { ThemeProvider } from '@/ui';
import { FONT_WAIT_MS, shouldRender, useAppFonts } from '@/ui/fonts';

// Hold the splash until the licence faces are in memory: the first frame of RoadWise has to be
// printed in B612, not in the platform sans it would otherwise fall back to for one flash.
void SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash is already hidden (a fast reload). Nothing to hold.
});

const controller = runtimeController;

/**
 * Hands the signed-in account's age band to the drive host whenever the profile changes (ruling
 * T12 (1)): an under-13 account never arms, so the block screen needs no disarm call of its own.
 * Inside `SessionProvider`, where the profile lives; nothing is handed over until a profile exists,
 * so the cached band the launch read stands meanwhile.
 */
function AgeBandSync({ host }: { host: { setAgeBand(band: string | null): Promise<void> } }) {
  const { profile } = useSession();
  const band = profile?.age_band ?? null;
  const known = profile !== null && profile !== undefined;
  useEffect(() => {
    if (known) void host.setAgeBand(band).catch(() => {});
  }, [host, band, known]);
  return null;
}

/**
 * M4's runtime-bound hosts (Task 18), inside the data, query, drive and session providers:
 * - `DeviceHost`: the device row, the permission report and the push token; on each foreground it
 *   syncs the notification preferences (T7). No `subscribeDrive`: the runtime is the one drive-state
 *   reporter (T10 r2, H2).
 * - `NotificationsHost`: the app's only notification handler and response listener (rev1: C1).
 *   Foreground banners stay hidden for the whole of a drive, not only while recording (T5 review).
 *   U3's summary notifier stays attached by the runtime itself (bootstrap), not here.
 * - `PermissionPromptsHost`: the post-drive background-location offers (T9), keyed by the signed-in
 *   account so a handover remounts it and its "finished" ref never holds back the next owner.
 */
function RuntimeHosts({ runtime, ready }: { runtime: AppRuntime; ready: boolean }) {
  const host = runtime.drive;
  const { session } = useSession();
  const uid = session?.user.id ?? null;
  const isBusy = useCallback(() => host.isBusy(), [host]);
  const subscribeBusy = useCallback((listener: () => void) => host.subscribe(() => listener()), [host]);
  const onForeground = useCallback(
    (userId: string) => syncNotificationPrefs(userId, { db: runtime.db }),
    [runtime]
  );
  return (
    <>
      <DeviceHost onForeground={onForeground} />
      <NotificationsHost
        isRecording={isBusy}
        isBusy={isBusy}
        subscribeBusy={subscribeBusy}
        ready={ready}
      />
      <PermissionPromptsHost key={uid ?? 'signed-out'} isBusy={isBusy} />
    </>
  );
}

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

  // §8.2 (final review I3; final-fix security I-1): only a sign-in by this device's owner — a
  // `SIGNED_IN` whose uid is the recorded owner (or a device nobody owns yet), or the owner's
  // `INITIAL_SESSION` at a slow launch — lets auto-record follow the opt-in again. A token refresh
  // or any other event never does, and the host ignores these while its sign-out is in progress.
  // A different driver is a handover: the rebuild's new host decides from its own launch.
  useEffect(() => {
    if (runtime === null) return;
    let live = true;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        // The driver's sign-out, or one they did not start (a revoked or expired session): either
        // way recording stops, an open drive finalized under the owner first (security r2-M2).
        // Then, once the drive-state attempts already started have run, nothing more is retried:
        // with the session gone, a retry is only an RLS refusal at every foreground (r2 n1).
        void runtime.drive
          .sessionEnded()
          .then(() => runtime.driveStateAbandon())
          .catch(() => {});
        return;
      }
      if (!session) return;
      const uid = session.user.id;
      if (event === 'SIGNED_IN') {
        void (async () => {
          const owner = await readDeviceOwner(runtime.db);
          if (!live) return;
          if (owner === uid) return runtime.drive.signedInAgain();
          // No owner recorded: arm only on a device holding no drive data. One that holds some is
          // a pre-owner device with somebody's drives, and the handover decides (security r2-M1).
          if (owner === null && !(await hasDriverData(runtime.db)) && live) {
            return runtime.drive.signedInAgain();
          }
        })().catch(() => {});
        return;
      }
      // A cold launch whose session arrived only now (a slow keychain): the device owner's own
      // restored session re-arms, or a long-lived process would silently miss drives for days.
      // The host refuses it during a sign-out and after one completed (ruling on H2 concern 2).
      if (event === 'INITIAL_SESSION') {
        void readDeviceOwner(runtime.db)
          .then((owner) => {
            if (live && owner === uid) return runtime.drive.signedInAgain({ initial: true });
          })
          .catch(() => {});
      }
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [runtime]);

  const fontsReady = shouldRender({ loaded, error, timedOut });
  const ready =
    fontsReady && (runtime !== null || state.error !== null || state.status === 'switching');

  // The push-token release (T10), once per runtime: a rebuild's cleanup unregisters it before the
  // next runtime registers its own. It runs inside the sign-out's 2 s budget, reads the token and
  // the uid it was registered for at its start, and sends nothing unless the session is still that
  // uid, so it can never release under the next driver's JWT (T17 security).
  useEffect(() => {
    if (runtime === null) return;
    const settings = createSettingsRepo(runtime.db);
    return registerBeforeSignOut(() => unregisterPushToken({ settings }));
  }, [runtime]);

  // The sync watermark's release (M5 R-A), once per runtime beside the token's: with nothing left
  // to upload, this phone stops holding its owner's reward days (`devices.signed_out_at`). With a
  // drive still owed it writes nothing (rev2 m1a). Bounded to 2 s; it never holds the sign-out.
  useEffect(() => {
    if (runtime === null) return;
    return registerBeforeSignOut(() => runtime.syncWatermarkBeforeSignOut());
  }, [runtime]);

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
        : {
            // Recording stops (the open drive finalized), then the drive state's `idle` is written
            // while this driver's session is still valid (T10 security): the server must not keep
            // a stale "driving" that holds pushes after the sign-out.
            stop: async () => {
              await runtime.drive.suspendForSignOut();
              await runtime.driveStateSettled();
            },
            resume: () => runtime.drive.resumeAfterSignIn(),
          },
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
                  <AgeBandSync host={runtime.drive} />
                  <RestoreRetryProvider retry={retryRestore}>
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
                          <Stack.Screen name="auth/callback" />
                          {/* No swipe-back out of a drive: it is left through its own controls. */}
                          <Stack.Screen
                            name="drive"
                            options={{ gestureEnabled: false, presentation: 'fullScreenModal' }}
                          />
                        </Stack>
                      </LockoutGate>
                    </AuthGate>
                    <RuntimeHosts runtime={runtime} ready={ready && runtime !== null} />
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
