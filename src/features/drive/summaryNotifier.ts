/**
 * The "Your drive recap is ready" notification: LOCAL, posted on the phone the moment a kept drive
 * ends while the app is not showing its end flow (a drive that ended on its own with the phone in a
 * pocket, a drive ended from the lock screen): "24 min · 12.0 mi. See how it went." Tapping it
 * opens the recap (`/drives/<id>?fresh=1`). A drive set off again within 5 minutes continues the
 * same trip, so its next end posts again under the same identifier with the longer drive's
 * numbers, replacing the first. A drive discarded with "Not driving?", or not kept, posts nothing;
 * a re-opened drive discarded with "Not driving?" also takes down the recap its first leg posted
 * (the drive it opens no longer exists).
 * Nothing here asks for notification permission, and nothing here starts a drive.
 *
 * Battery: the host listener compares one field per change and returns; the OS is touched only
 * when a drive finalizes.
 */
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { createSettingsRepo, type Db } from '@/data/db';
import type { DriveHost, LastFinalized } from '@/drive/host';
import { formatDuration } from '@/features/drives/format';
import { ensureNotificationSetup } from '@/features/notifications/categories';
import { formatDistance, type Units } from '@/lib/units';

/** `content.data.kind` of every drive-summary request, so cancels find only ours. */
export const DRIVE_SUMMARY_KIND = 'driveSummary';
/** The Android channel (created by `ensureAndroidChannels`). */
export const SUMMARY_CHANNEL_ID = 'trips';
const IDENTIFIER_PREFIX = 'drive-summary:';

export const summaryCopy = {
  title: 'Your drive recap is ready',
  /** "24 min · 12.0 mi. See how it went."; without the numbers, the last sentence alone. */
  body: (durationS: number | null, miles: number | null, units: Units): string =>
    durationS === null || miles === null ? 'See how it went.' : `${formatDuration(durationS)} · ${formatDistance(miles, units)}. See how it went.`,
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
  /** The driver's units for the distance (`summaryUnits(db)`); miles when absent or unreadable. */
  units?: () => Promise<Units>;
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

/** The driver's units from the local settings mirror, for `SummaryNotifierDeps.units`. */
export function summaryUnits(db: Db): () => Promise<Units> {
  return async () => ((await createSettingsRepo(db).get<unknown>('units')) === 'km' ? 'km' : 'mi');
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

  const unitsNow = async (): Promise<Units> => {
    try {
      return (await deps.units?.()) ?? 'mi';
    } catch {
      return 'mi';
    }
  };

  const announce = async (clientTripId: string, durationS: number | null, miles: number | null): Promise<void> => {
    if (appState.currentState === 'active' && (deps.isSummaryVisible?.() ?? true)) return;
    if (!(await port.permissionGranted())) return;
    // One identifier per trip: a continuation's end replaces the first recap with the longer drive.
    await port.schedule({
      identifier: `${IDENTIFIER_PREFIX}${clientTripId}`,
      clientTripId,
      title: summaryCopy.title,
      body: summaryCopy.body(durationS, miles, await unitsNow()),
      url: summaryHref(clientTripId),
    });
  };

  const off = host.subscribe((s) => {
    const f = s.lastFinalized;
    if (f === seen || f === null) return;
    const fresh = seen === null || f.clientTripId !== seen.clientTripId || f.at !== seen.at;
    seen = f;
    // "Not driving?" deleted the drive, a re-opened one with its first leg: that leg's recap goes too.
    if (fresh && f.ok && f.dropped === 'cancelled') {
      const id = f.clientTripId;
      chain = chain.then(() => port.cancel(`${IDENTIFIER_PREFIX}${id}`)).catch((e: unknown) => report(e, 'summary notification'));
      return;
    }
    // A drive that was not kept has no recap.
    if (!fresh || !f.ok || f.status === 'failed' || f.dropped !== null) return;
    chain = chain.then(() => announce(f.clientTripId, f.durationS, f.miles)).catch((e: unknown) => report(e, 'summary notification'));
  });

  return {
    detach: off,
    settled: () => chain,
  };
}
