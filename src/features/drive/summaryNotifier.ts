/**
 * The "Drive ended — see your points" notification: LOCAL, scheduled on the phone when a drive
 * finalizes while the app is not in front (an auto-end with the phone in a pocket, a drive ended
 * from the lock screen). Tapping it opens the summary (`/drives/<id>?fresh=1`). Nothing here asks
 * for notification permission, and nothing here starts a drive.
 *
 * Battery: the host listener compares one field per change and returns; the OS is touched only
 * when a drive finalizes.
 */
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import type { DriveHost, LastFinalized } from '@/drive/host';
import { ensureNotificationSetup } from '@/features/notifications/categories';

/** `content.data.kind` of every drive-summary request, so cancels find only ours. */
export const DRIVE_SUMMARY_KIND = 'driveSummary';
/** The Android channel (created by `ensureAndroidChannels`). */
export const SUMMARY_CHANNEL_ID = 'trips';
const IDENTIFIER_PREFIX = 'drive-summary:';

export const summaryCopy = {
  title: 'Drive ended',
  body: 'See your points',
} as const;

export const summaryHref = (clientTripId: string): string => `/drives/${clientTripId}?fresh=1`;

export interface SummaryRequest {
  identifier: string;
  clientTripId: string;
  title: string;
  body: string;
  url: string;
}

/** Everything this module asks of the OS. */
export interface SummaryNotificationPort {
  /** Read only — never prompts. */
  permissionGranted(): Promise<boolean>;
  schedule(req: SummaryRequest): Promise<void>;
  /** Our pending or delivered requests' identifiers. */
  scheduled(): Promise<string[]>;
  cancel(identifier: string): Promise<void>;
}

export interface SummaryNotifierDeps {
  port?: SummaryNotificationPort;
  appState?: { currentState: string | null };
  /** The app is showing the end flow for this drive: no notification. */
  isSummaryVisible?: () => boolean;
  onError?: (e: unknown, ctx: string) => void;
}

export interface SummaryNotifier {
  detach(): void;
  /** Resolves once every OS call queued so far has finished. */
  settled(): Promise<void>;
}

export function createExpoSummaryPort(): SummaryNotificationPort {
  return {
    async permissionGranted() {
      const p = await Notifications.getPermissionsAsync();
      return p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    },
    async schedule(req) {
      await ensureNotificationSetup();
      await Notifications.scheduleNotificationAsync({
        identifier: req.identifier,
        content: {
          title: req.title,
          body: req.body,
          data: { kind: DRIVE_SUMMARY_KIND, url: req.url, clientTripId: req.clientTripId },
          ...({ channelId: SUMMARY_CHANNEL_ID } as object),
        },
        trigger: null,
      });
    },
    async scheduled() {
      const pending = await Notifications.getAllScheduledNotificationsAsync();
      return pending.filter((n) => n.content.data?.kind === DRIVE_SUMMARY_KIND).map((n) => n.identifier);
    },
    async cancel(identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier);
      await Notifications.dismissNotificationAsync(identifier).catch(() => {});
    },
  };
}

/** Remove every drive summary this app scheduled (the handover wipe). */
export async function cancelDriveSummaries(port: SummaryNotificationPort = createExpoSummaryPort()): Promise<void> {
  for (const id of await port.scheduled()) await port.cancel(id).catch(() => {});
}

export function attachSummaryNotifier(host: Pick<DriveHost, 'subscribe' | 'snapshot'>, deps: SummaryNotifierDeps = {}): SummaryNotifier {
  const port = deps.port ?? createExpoSummaryPort();
  const appState = deps.appState ?? AppState;
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);
  let chain: Promise<void> = Promise.resolve();
  let seen: LastFinalized = host.snapshot().lastFinalized;

  const announce = async (clientTripId: string): Promise<void> => {
    if (appState.currentState === 'active' && (deps.isSummaryVisible?.() ?? true)) return;
    if (!(await port.permissionGranted())) return;
    await port.schedule({
      identifier: `${IDENTIFIER_PREFIX}${clientTripId}`,
      clientTripId,
      title: summaryCopy.title,
      body: summaryCopy.body,
      url: summaryHref(clientTripId),
    });
  };

  const off = host.subscribe((s) => {
    const f = s.lastFinalized;
    if (f === seen || f === null) return;
    const fresh = seen === null || f.clientTripId !== seen.clientTripId || f.at !== seen.at;
    seen = f;
    // A drive that was not kept has no summary: Home carries its notice instead.
    if (!fresh || !f.ok || f.status === 'failed' || f.dropped !== null) return;
    chain = chain.then(() => announce(f.clientTripId)).catch((e: unknown) => report(e, 'summary notification'));
  });

  return {
    detach: off,
    settled: () => chain,
  };
}
