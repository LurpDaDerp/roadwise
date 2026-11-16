import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * The app's touch feedback: the few touches RoadWise answers with a feel (a swipe passing its
 * commit point, a swipe or a dashcam step done, the driving screen's buttons and panels). Every
 * caller goes through here, never straight to expo-haptics, so each platform gets its own idiom:
 *
 * - iPhone: the Taptic engine exactly as before, `impactAsync(Light)` for a tick or a press and
 *   `notificationAsync(Success)` for a success.
 * - Android: the system's own touch-feedback constants through `View.performHapticFeedback`
 *   (`performAndroidHapticsAsync`), the crisp clicks the phone's own keyboard, sliders and dialogs
 *   use. They follow the phone's "Touch feedback" setting, as the Taptic engine follows the
 *   iPhone's, and need no permission. expo-haptics' impact and notification calls are `Vibrator`
 *   one-shots on Android: a buzz, not a click.
 *
 * Android's constants arrived over several releases (VIRTUAL_KEY in every release; CONFIRM in
 * Android 11, API 30; SEGMENT_TICK in Android 14, API 34), and expo-haptics rejects a constant the
 * phone lacks, so an older phone gets VIRTUAL_KEY, the button click every Android phone has. This is
 * UI feedback only: the alert pulses that must reach a phone in a pocket are the alert player's
 * vibrator patterns (`src/core/alerts/adapters.ts`). Every call is fire-and-forget and never
 * throws: a phone without haptics just stays still.
 */

/** API 30 (Android 11): `HapticFeedbackConstants.CONFIRM`. */
export const ANDROID_CONFIRM_API = 30;
/** API 34 (Android 14): `HapticFeedbackConstants.SEGMENT_TICK`. */
export const ANDROID_SEGMENT_TICK_API = 34;

/** `tick`: a threshold passed or a panel opening; `press`: a button; `success`: something done. */
export type Feel = 'tick' | 'press' | 'success';

/** The Android constant for a feel on `apiLevel`; read inside the call, so iOS never touches the enum. */
export function androidHapticFor(feel: Feel, apiLevel: number): Haptics.AndroidHaptics {
  const A = Haptics.AndroidHaptics;
  if (feel === 'success' && apiLevel >= ANDROID_CONFIRM_API) return A.Confirm;
  if (feel === 'tick' && apiLevel >= ANDROID_SEGMENT_TICK_API) return A.Segment_Tick;
  return A.Virtual_Key;
}

function apiLevel(): number {
  const v = Platform.Version;
  return typeof v === 'number' ? v : Number(v) || 0;
}

function play(feel: Feel): void {
  try {
    if (Platform.OS === 'android') {
      void Haptics.performAndroidHapticsAsync(androidHapticFor(feel, apiLevel())).catch(() => {});
    } else if (feel === 'success') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  } catch {
    // A runtime without the native module: no feel, nothing else changes.
  }
}

export const haptics = {
  /** A swipe passing its commit point, a panel opening on the driving screen. */
  tick: (): void => play('tick'),
  /** A button pressed: SOS, a call, the navigation button. */
  press: (): void => play('press'),
  /** Something just succeeded: a swipe committed, a dashcam paired or aimed. */
  success: (): void => play('success'),
};
