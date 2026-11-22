// The DashPal aiming picture kept out of screenshots, screen recordings and the app switcher, for
// setup's screen 3 (StepAim) and the re-aim sheet (ReaimSheet).
import { secureDialogs } from '@drive-sense/secureDialogs';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect } from 'react';

/**
 * How long the guard outlives the screen that showed the picture. A wizard step's exit (STEP_OUT_MS
 * 180, STEP_FADE_MS 150 under Reduce Motion) and the sheet's fade keep its last frame on screen
 * after the step has unmounted; the guard lasts past both.
 */
export const CAPTURE_RELEASE_MS = 400;

/** Mounts so far: each one guards under its own key. */
let mounts = 0;

/**
 * While the screen is mounted, and for `CAPTURE_RELEASE_MS` after: expo-screen-capture on the app's
 * window (iPhone's whole key window, the sheets in it; Android's activity), and on Android
 * FLAG_SECURE on React Native's Modal dialogs too, the separate windows the setup and re-aim
 * sheets draw in (`secureDialogs`). Each mount holds its own key, so a late release can never let
 * go of a newer mount's guard. Failures are dropped without a log (nothing that touches the
 * picture logs).
 */
export function useAimCaptureGuard(name: string): void {
  useEffect(() => {
    mounts += 1;
    const key = `${name}-${mounts}`;
    preventScreenCaptureAsync(key).catch(() => {});
    void secureDialogs(key, true);
    return () => {
      setTimeout(() => {
        allowScreenCaptureAsync(key).catch(() => {});
        void secureDialogs(key, false);
      }, CAPTURE_RELEASE_MS);
    };
  }, [name]);
}
