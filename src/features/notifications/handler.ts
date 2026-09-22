/**
 * The app's only foreground notification handler (`setNotificationHandler`).
 *
 * A notification that arrives while the app is open is shown quietly — a banner and the list, never
 * a sound or a badge — except while a drive is recording, when it is not shown at all: nothing may
 * compete for the driver's eyes (§11.1 "never while driving"). The recording state is read when
 * each notification arrives, not when the handler was installed.
 */
import * as Notifications from 'expo-notifications';

export type HandlerApi = Pick<typeof Notifications, 'setNotificationHandler'>;

export function foregroundBehavior(recording: boolean): Notifications.NotificationBehavior {
  return {
    shouldShowBanner: !recording,
    shouldShowList: !recording,
    shouldPlaySound: false,
    shouldSetBadge: false,
  };
}

/** The latest install; an older uninstall must not clear a newer handler. */
let current: object | null = null;

/** Installs the handler; the returned function removes it (idempotent). */
export function installForegroundHandler(
  opts: { isRecording: () => boolean },
  n: HandlerApi = Notifications
): () => void {
  const token = {};
  current = token;
  n.setNotificationHandler({
    handleNotification: async () => {
      let recording = true;
      try {
        recording = opts.isRecording();
      } catch {
        // Unknown counts as recording: a missed banner costs less than a distraction.
      }
      return foregroundBehavior(recording);
    },
  });
  return () => {
    if (current !== token) return;
    current = null;
    n.setNotificationHandler(null);
  };
}
