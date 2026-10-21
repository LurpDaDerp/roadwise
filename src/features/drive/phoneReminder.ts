/**
 * The phone reminder (phone plan P4): a LOCAL notification posted when the phone is picked up during
 * a drive while RoadWise is not active, in place of the alert the driving screen would play.
 *
 * "Phone down while you drive" · "Picking up your phone counts against this drive's score. Not the
 * driver? Tap to let us know." Silent (no sound; on Android the drive's own low-importance
 * channel). One identifier per drive (`phone-reminder:<clientTripId>`), so a newer one replaces the
 * older, and at most one per `PHONE_REMINDER_GAP_S` per drive, counted from the last reminder that
 * actually went up (a pickup that posted nothing starts no gap). The host decides which pickups may
 * remind at all (`DriveHostDeps.phoneReminder`: the pickup's first alert, RoadWise not active, a
 * live row at most 15 s old, a stored drive; never a replayed row, a dry run or the simulation).
 * Tapping it opens the driving screen while a drive records, by the recording note's path
 * (`kind: 'phoneReminder'`, `url: '/drive'`, `drivingHrefOf`), and nothing more once it is over.
 * It comes down when its drive ends, is discarded or is cancelled ("Not driving?"), and a launch
 * takes down any a process left behind for a drive no longer recording.
 *
 * Nothing here asks for notification permission (it is read only), and nothing here starts a drive.
 *
 * Battery: the host listener compares two fields per change and returns; the OS is touched only
 * when a reminder is posted or taken down.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { DriveHost, LastFinalized } from '@/drive/host';
import { ensureNotificationSetup } from '@/features/notifications/categories';
import { DRIVE_HREF, PHONE_REMINDER_KIND } from '@/features/notifications/hrefs';

export { PHONE_REMINDER_KIND };

/** At most one reminder per this many seconds of a drive (row clock), from the last one posted. */
export const PHONE_REMINDER_GAP_S = 120;
/**
 * The Android channel: the drive's own "Drive recording" channel (low importance: no sound, no
 * pop-up), which the capture creates as a drive starts. iOS ignores it.
 */
export const PHONE_REMINDER_CHANNEL_ID = 'drive_recording';
const IDENTIFIER_PREFIX = 'phone-reminder:';

export const phoneReminderIdentifier = (clientTripId: string): string => `${IDENTIFIER_PREFIX}${clientTripId}`;

export const phoneReminderCopy = {
  title: 'Phone down while you drive',
  body: "Picking up your phone counts against this drive's score. Not the driver? Tap to let us know.",
} as const;

export interface PhoneReminderRequest {
  identifier: string;
  clientTripId: string;
  title: string;
  body: string;
}

/** One of our reminders the OS holds (shown, or about to be). */
export interface PostedReminder {
  identifier: string;
  clientTripId: string | null;
}

/** Everything this module asks of the OS. */
export interface PhoneReminderPort {
  /** Read only — never prompts. */
  permissionGranted(): Promise<boolean>;
  /** Silent, now. */
  post(req: PhoneReminderRequest): Promise<void>;
  /** Our reminders shown or pending (by kind). */
  posted(): Promise<PostedReminder[]>;
  cancel(identifier: string): Promise<void>;
}

const isOurs = (data: unknown): data is { clientTripId?: unknown } =>
  typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === PHONE_REMINDER_KIND;

const postedOf = (identifier: string, data: unknown): PostedReminder | null => {
  if (!isOurs(data) || !identifier.startsWith(IDENTIFIER_PREFIX)) return null;
  return { identifier, clientTripId: typeof data.clientTripId === 'string' ? data.clientTripId : null };
};

export function createExpoPhoneReminderPort(): PhoneReminderPort {
  return {
    async permissionGranted() {
      const p = await Notifications.getPermissionsAsync();
      return p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    },
    async post(req) {
      await ensureNotificationSetup();
      await Notifications.scheduleNotificationAsync({
        identifier: req.identifier,
        content: {
          title: req.title,
          body: req.body,
          sound: false,
          data: { kind: PHONE_REMINDER_KIND, url: DRIVE_HREF, clientTripId: req.clientTripId },
        },
        // Android reads the channel only from the trigger (a channel-aware trigger posts at once);
        // iOS has no channels and posts a null trigger at once.
        trigger: Platform.OS === 'android' ? { channelId: PHONE_REMINDER_CHANNEL_ID } : null,
      });
    },
    async posted() {
      const [shown, pending] = await Promise.all([Notifications.getPresentedNotificationsAsync(), Notifications.getAllScheduledNotificationsAsync()]);
      const out = new Map<string, PostedReminder>();
      for (const n of shown) {
        const r = postedOf(n.request.identifier, n.request.content.data);
        if (r !== null) out.set(r.identifier, r);
      }
      for (const n of pending) {
        const r = postedOf(n.identifier, n.content.data);
        if (r !== null) out.set(r.identifier, r);
      }
      return [...out.values()];
    },
    async cancel(identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
      await Notifications.dismissNotificationAsync(identifier).catch(() => {});
    },
  };
}

/** Take down every phone reminder this app posted (sign-out and the handover wipe). */
export async function cancelPhoneReminders(port: PhoneReminderPort = createExpoPhoneReminderPort()): Promise<void> {
  for (const r of await port.posted()) await port.cancel(r.identifier).catch(() => {});
}

export interface PhoneReminderDeps {
  port?: PhoneReminderPort;
  onError?: (e: unknown, ctx: string) => void;
}

export interface PhoneReminder {
  /** A phone pickup's first alert the host let through: post unless one went up for this drive under `PHONE_REMINDER_GAP_S` ago. */
  pickup(p: { clientTripId: string; at: number }): void;
  /** Follow the host: a drive's reminder comes down as the drive stops recording (ended, discarded, cancelled) or is finalized. Returns the detach. */
  attach(host: Pick<DriveHost, 'subscribe' | 'snapshot'>): () => void;
  /** Take down every reminder of a drive that is not recording now (left by an earlier process). Call once the host has booted. */
  sweep(): void;
  /** Resolves once every OS call queued so far has finished. */
  settled(): Promise<void>;
}

export function createPhoneReminder(deps: PhoneReminderDeps = {}): PhoneReminder {
  const port = deps.port ?? createExpoPhoneReminderPort();
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);
  let chain: Promise<void> = Promise.resolve();
  const queue = (fn: () => Promise<void>, ctx: string): void => {
    chain = chain.then(fn).catch((e: unknown) => report(e, ctx));
  };
  /** Per drive: the row clock of the last reminder posted. */
  const lastAt = new Map<string, number>();
  let host: Pick<DriveHost, 'subscribe' | 'snapshot'> | null = null;

  const takeDown = (clientTripId: string): void => {
    queue(async () => {
      lastAt.delete(clientTripId);
      await port.cancel(phoneReminderIdentifier(clientTripId));
    }, 'phone reminder');
  };

  /** The drive recording now, or null. */
  const recordingId = (): string | null => {
    const s = host?.snapshot();
    return s !== undefined && s.status === 'recording' ? s.clientTripId : null;
  };

  return {
    pickup({ clientTripId, at }) {
      // In the queue, so each pickup sees the one before it posted (or not); only a reminder that
      // went up starts the gap: one skipped (no permission, the drive over) or refused does not.
      queue(async () => {
        const last = lastAt.get(clientTripId);
        if (last !== undefined && at - last < PHONE_REMINDER_GAP_S * 1000) return;
        if (!(await port.permissionGranted())) return;
        // The drive may have ended meanwhile: its reminder would only open a drive that is over.
        if (host !== null && recordingId() !== clientTripId) return;
        await port.post({ identifier: phoneReminderIdentifier(clientTripId), clientTripId, title: phoneReminderCopy.title, body: phoneReminderCopy.body });
        lastAt.set(clientTripId, at);
      }, 'phone reminder');
    },
    attach(h) {
      host = h;
      let open = recordingId();
      let seen: LastFinalized = h.snapshot().lastFinalized;
      const off = h.subscribe((s) => {
        const now = s.status === 'recording' ? s.clientTripId : null;
        if (open !== null && now !== open) takeDown(open);
        open = now;
        const f = s.lastFinalized;
        if (f === seen) return;
        seen = f;
        // Finalized, dropped, cancelled or failed: that drive is over (also one this process never saw record).
        if (f !== null && f.clientTripId !== now) takeDown(f.clientTripId);
      });
      return () => {
        off();
        if (host === h) host = null;
      };
    },
    sweep() {
      queue(async () => {
        const keep = recordingId();
        for (const r of await port.posted()) {
          if (r.clientTripId !== null && r.clientTripId === keep) continue;
          await port.cancel(r.identifier);
        }
      }, 'phone reminder');
    },
    settled: () => chain,
  };
}
