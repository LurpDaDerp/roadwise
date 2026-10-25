/**
 * The "Your drive recap is ready" notification: LOCAL, posted on the phone the moment a kept drive
 * ends while the driving screen is not in front to open the recap itself (RoadWise behind or the
 * phone locked, or RoadWise in front on another screen): "24 min · 12.0 mi. See how it went."
 * Tapping it opens the recap (`/drives/<id>?fresh=1`). An automatic drive that ends on its own in
 * the background posts it like any other. Each drive posts its recap once, and it stays up; a drive
 * discarded with "Not driving?", or not kept, posts nothing.
 *
 * Attached before the drive host boots, so a drive the boot stores (native ended it while no
 * process ran) posts too, when it ended within the last `RECAP_MAX_AGE_MS`; an older one is only
 * in the drive list. An orphan the launch's crash recovery ends before the host exists is handed
 * over by the launch (`announceStored`) and posts by the same rules. A recap due while a drive
 * records (a launch that stores the last drive and then takes in the one recording now) waits until
 * no drive records, so nothing banners mid-drive; it then posts even with the driving screen in
 * front, since that screen shows the later drive, never this one. Nothing here asks for
 * notification permission, and nothing here starts a drive.
 *
 * Getting the post out before iOS suspends a background app: every detector drive's end (native's
 * own, or JS's through `stopCapture`) runs inside native's 25 s end task (`drivesense.end`), and an
 * automatic end keeps GPS on for native's post-end watch after it; the chain here (permission,
 * units, schedule) takes well under a second.
 *
 * Battery: the host listener compares a few fields per change and returns; the OS is touched only
 * when a drive finalizes.
 */
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { createSettingsRepo, type Db } from '@/data/db';
import type { DriveHost, LastFinalized } from '@/drive/host';
import { formatDuration } from '@/features/drives/format';
import { isDriveScreenFocused } from '@/features/drive/hudPresence';
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
  /**
   * With RoadWise in front, the driving screen shows the drive's end and opens its recap itself: no
   * notification. Default: the driving screen is focused (`isDriveScreenFocused`).
   */
  isSummaryVisible?: () => boolean;
  /** Epoch ms now, for the age rule (default `Date.now`). */
  now?: () => number;
  /** The driver's units for the distance (`summaryUnits(db)`); miles when absent or unreadable. */
  units?: () => Promise<Units>;
  onError?: (e: unknown, ctx: string) => void;
}

/** A kept drive, as the host's `lastFinalized` states it (and as the launch states an orphan it stored). */
export type StoredDrive = Extract<NonNullable<LastFinalized>, { ok: true }>;

export interface SummaryNotifier {
  detach(): void;
  /**
   * Drives stored without the host (the launch's crash recovery ending an orphan): each kept one
   * posts by the same rules as a drive the host ends (recent enough, not with the driving screen in
   * front, held while a drive records).
   */
  announceStored(drives: readonly StoredDrive[]): void;
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
      // Posted with no trigger, a recap is delivered at once and never pending: the ones in
      // Notification Center are listed too, so the handover wipe takes them down as well.
      const [pending, presented] = await Promise.all([
        Notifications.getAllScheduledNotificationsAsync(),
        Notifications.getPresentedNotificationsAsync().catch(() => [] as Notifications.Notification[]),
      ]);
      const ids = [
        ...pending.filter((n) => n.content.data?.kind === DRIVE_SUMMARY_KIND).map((n) => n.identifier),
        ...presented.filter((n) => n.request.content.data?.kind === DRIVE_SUMMARY_KIND).map((n) => n.request.identifier),
      ];
      return [...new Set(ids)];
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

/** A drive that ended longer ago than this (a launch storing it hours later) posts no recap: it is in the drive list. */
export const RECAP_MAX_AGE_MS = 2 * 60 * 60_000;

type Kept = StoredDrive;
/** Why a recap is announced: a drive's end seen now, a launch's stored orphan, or one held while another drive recorded. */
type Due = 'end' | 'stored' | 'held';
const isKept = (f: Kept): boolean => f.status !== 'failed' && f.dropped === null;

export function attachSummaryNotifier(host: Pick<DriveHost, 'subscribe' | 'snapshot'>, deps: SummaryNotifierDeps = {}): SummaryNotifier {
  const port = deps.port ?? createExpoSummaryPort();
  const appState = deps.appState ?? AppState;
  const screenShowsEnd = deps.isSummaryVisible ?? isDriveScreenFocused;
  const now = deps.now ?? Date.now;
  const report = (e: unknown, ctx: string) => deps.onError?.(e, ctx);
  let chain: Promise<void> = Promise.resolve();
  let seen: LastFinalized = host.snapshot().lastFinalized;
  /** Recaps due while a drive recorded: they post once none does. */
  const held = new Map<string, Kept>();
  let detached = false;

  const unitsNow = async (): Promise<Units> => {
    try {
      return (await deps.units?.()) ?? 'mi';
    } catch {
      return 'mi';
    }
  };

  const enqueue = (fn: () => Promise<void>): void => {
    chain = chain.then(fn).catch((e: unknown) => report(e, 'summary notification'));
  };

  const announce = async (f: Kept, due: Due): Promise<void> => {
    if (detached) return;
    // Stored at a launch long after it ended: no recap now.
    if (now() - (f.endedAt ?? f.at) > RECAP_MAX_AGE_MS) return;
    // The driving screen in front opens the recap itself. Not a held one's: that screen showed the
    // later drive's end, never this one's.
    if (due !== 'held' && appState.currentState === 'active' && screenShowsEnd()) return;
    if (!(await port.permissionGranted())) return;
    const body = summaryCopy.body(f.durationS, f.miles, await unitsNow());
    if (detached) return;
    // Another drive recording (or this end still finishing): this recap waits until none is open.
    if (host.snapshot().status !== 'idle') {
      held.set(f.clientTripId, f);
      return;
    }
    // One identifier per trip.
    await port.schedule({
      identifier: `${IDENTIFIER_PREFIX}${f.clientTripId}`,
      clientTripId: f.clientTripId,
      title: summaryCopy.title,
      body,
      url: summaryHref(f.clientTripId),
    });
  };

  const off = host.subscribe((s) => {
    const f = s.lastFinalized;
    if (f !== seen && f !== null) {
      const fresh = seen === null || f.clientTripId !== seen.clientTripId || f.at !== seen.at;
      seen = f;
      if (fresh) {
        held.delete(f.clientTripId);
        // A drive that was not kept (or discarded with "Not driving?") has no recap. The driving
        // screen in front at the moment the drive ended opens the recap itself (it may have moved on
        // to it before the chain runs).
        if (f.ok && isKept(f) && !(appState.currentState === 'active' && screenShowsEnd())) enqueue(() => announce(f, 'end'));
      }
    }
    // No drive records any more: the recaps held meanwhile post, each by the same rules but the
    // in-front one (the driving screen in front shows the drive that just ended, not these).
    if (s.status === 'idle' && held.size > 0) {
      const due = [...held.values()];
      held.clear();
      for (const h of due) enqueue(() => announce(h, 'held'));
    }
  });

  return {
    detach() {
      detached = true;
      held.clear();
      off();
    },
    announceStored(drives) {
      for (const f of drives) if (f.ok && isKept(f)) enqueue(() => announce(f, 'stored'));
    },
    settled: () => chain,
  };
}

