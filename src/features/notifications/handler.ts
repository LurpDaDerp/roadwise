/**
 * The app's only foreground notification handler (`setNotificationHandler`).
 *
 * A notification that arrives while the app is open is shown quietly — a banner and the list, never
 * a sound or a badge — except while a drive is recording, when it is not shown at all: nothing may
 * compete for the driver's eyes (§11.1 "never while driving"). The recording state is read when
 * each notification arrives, not when the handler was installed.
 *
 * Android and the drive recap: expo builds a notification whose behaviour allows neither a sound
 * nor a vibration with `setSilent(true)`, and a silent notification never peeks as a heads-up, so
 * on Android `shouldPlaySound: false` would keep the recap out of a banner whatever its channel. The
 * recap's channel (`recaps`, `channels.ts`) is HIGH with no sound and no vibration, and on Android 8+
 * the channel alone decides the sound, so letting the recap "play" its sound plays nothing and lets
 * it banner as it does on iOS. Every other notification keeps `shouldPlaySound: false` (the
 * `pushes` channel has a sound, and the app stays quiet in front as on iOS); iOS is unchanged.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type HandlerApi = Pick<typeof Notifications, 'setNotificationHandler'>;

/**
 * `content.data.kind` of the local drive recap: equals `DRIVE_SUMMARY_KIND` in
 * src/features/drive/summaryNotifier.ts (not imported, so this module stays free of the drive code).
 */
const RECAP_KIND = 'driveSummary';

export function foregroundBehavior(
  recording: boolean,
  opts: { kind?: unknown; os?: string } = {}
): Notifications.NotificationBehavior {
  const os = opts.os ?? Platform.OS;
  return {
    shouldShowBanner: !recording,
    shouldShowList: !recording,
    shouldPlaySound: !recording && os === 'android' && opts.kind === RECAP_KIND,
    shouldSetBadge: false,
  };
}

/** The latest install; an older uninstall must not clear a newer handler. */
let current: object | null = null;

/** Installs the handler; the returned function removes it (idempotent). */
export function installForegroundHandler(
  opts: { isRecording: () => boolean; os?: string },
  n: HandlerApi = Notifications
): () => void {
  const token = {};
  current = token;
  n.setNotificationHandler({
    handleNotification: async (notification) => {
      let recording = true;
      try {
        recording = opts.isRecording();
      } catch {
        // Unknown counts as recording: a missed banner costs less than a distraction.
      }
      const kind = (notification?.request?.content?.data as Record<string, unknown> | null | undefined)?.kind;
      return foregroundBehavior(recording, { kind, ...(opts.os !== undefined ? { os: opts.os } : {}) });
    },
  });
  return () => {
    if (current !== token) return;
    current = null;
    n.setNotificationHandler(null);
  };
}
