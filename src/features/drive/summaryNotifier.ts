/**
 * The "your drive is ready" notification (§11.2 "Trip summary ready"; cross-plan ruling: LOCAL,
 * scheduled on the phone at finalize, never pushed by the server for this device's own trips).
 *
 * The rules (M3 brief U3, rev1: I14):
 * - At finalize, one local notification with an OS time trigger of 120 s — §11.2's "≥ 2 min after
 *   end". No JS timer is involved: iOS suspends a backgrounded app, so the OS holds the delay.
 * - Only when notification permission is ALREADY granted. This module never asks.
 * - Never for a short, discarded, failed or simulated drive, and never while the app is in the
 *   foreground on the end screen (that screen is the answer).
 * - A new candidate or recording cancels the pending request, so nothing lands while driving.
 *   The cancelled drive is carried, not forgotten: when that next drive ends — or turns out to
 *   be a false start — the carried drive is announced again with a fresh 120 s, batched with the
 *   new one when it qualifies ("2 drives are ready"). This is how "a second finalize before it
 *   fires replaces it with a batched notification" can happen at all: every second drive begins
 *   with a candidate or a recording, which is exactly what cancels the first request.
 * - Copy carries no score and no places (§11.1 rule 5: privacy-safe on the lock screen).
 *
 * Honesty: a `lastFinalized` carries over into the next trip (H1 review), so an outcome is only
 * news when its `clientTripId` is the trip this notifier watched being recorded.
 *
 * Seam for M4 (controller ruling): the OS calls sit behind `SummaryNotificationPort`, and the
 * words behind `summaryContent`. M4's notification catalog (`renderLocal`, `localDeliveryPlan`)
 * replaces either without touching the rules. M4 Task 19 retires or replaces this file (N-m3).
 *
 * Battery (§3.5): the host listener compares two fields per change and returns; the OS is only
 * touched on a status edge or a finalize — never on the 1 Hz path, and never while armed and idle.
 */
import * as Notifications from 'expo-notifications';
import type { Href } from 'expo-router';
import { AppState, Platform } from 'react-native';

import type { EngineStatus } from '@/core/engine/engine.types';
import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { TRIP_HISTORY_HREF, tripSummaryHref } from '@/features/trips/routes';

import { startCopy } from './startCopy';

/** §11.2 "≥ 2 min after end", held by the OS. */
export const DRIVE_SUMMARY_DELAY_S = 120;
/** `content.data.kind` of every drive-summary request, so routing and cancels find only ours. */
export const DRIVE_SUMMARY_KIND = 'driveSummary';
export const DRIVE_SUMMARY_CHANNEL_ID = 'drive-summary';
const IDENTIFIER_PREFIX = 'drive-summary:';

/**
 * OPEN PRODUCT QUESTION (pending with the user): does a drive summary count toward §11.1's
 * "≤ 2 non-family notifications per day"? M3 answers no, so the cap is not consulted. Flip this one
 * constant to make every schedule ask `dailyCapAllows` first (M4 owns the counter behind it).
 * Flipped with no `dailyCapAllows` supplied, the notifier fails closed: nothing is scheduled and
 * the gap is reported once (U3 review m3 — a cap that exists only in a comment is no cap).
 */
export const DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP = false;

export function summaryCountsTowardDailyCap(): boolean {
  return DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP;
}

export interface ScheduledSummary {
  identifier: string;
  clientTripIds: string[];
}

export interface SummaryRequest extends ScheduledSummary {
  title: string;
  body: string;
  seconds: number;
}

/** Everything this module asks of the OS. M4 may swap it for its catalog's delivery. */
export interface SummaryNotificationPort {
  /** Read only — never prompts. */
  permissionGranted(): Promise<boolean>;
  /** Our pending (not yet delivered) requests. */
  scheduled(): Promise<ScheduledSummary[]>;
  schedule(req: SummaryRequest): Promise<void>;
  cancel(identifier: string): Promise<void>;
}

export interface SummaryNotifierDeps {
  port?: SummaryNotificationPort;
  appState?: { currentState: string | null };
  isEndScreenVisible?: () => boolean;
  /**
   * Consulted only when the cap switch is on — and then REQUIRED: without it nothing is
   * scheduled (fail closed). There is no default-allow.
   */
  dailyCapAllows?: () => Promise<boolean>;
  /** The cap switch; defaults to `summaryCountsTowardDailyCap` (tests flip it here). */
  countsTowardDailyCap?: () => boolean;
  onError?: (e: unknown, ctx: string) => void;
}

export interface SummaryNotifier {
  detach(): void;
  /** Resolves once every OS call queued so far has finished (tests, shutdown). */
  settled(): Promise<void>;
}

/** The words. One drive, or a batch — never a score, never a place. */
export function summaryContent(clientTripIds: readonly string[]): { title: string; body: string } {
  const c = startCopy.notification;
  return clientTripIds.length > 1
    ? { title: c.batchTitle(clientTripIds.length), body: c.batchBody }
    : { title: c.title, body: c.body };
}

// ——— the end screen's presence (C8 marks itself; read synchronously at finalize) ———

let endScreenVisible = false;

/** Called by `EndScreen` on mount (true) and unmount (false). */
export function setEndScreenVisible(visible: boolean): void {
  endScreenVisible = visible;
}

// ——— the OS port ———

const isOurs = (data: unknown): data is { kind: string; clientTripIds: string[] } =>
  typeof data === 'object' &&
  data !== null &&
  (data as { kind?: unknown }).kind === DRIVE_SUMMARY_KIND &&
  Array.isArray((data as { clientTripIds?: unknown }).clientTripIds);

export function createExpoSummaryPort(os: string = Platform.OS): SummaryNotificationPort {
  let channelReady = false;
  return {
    async permissionGranted() {
      const p = await Notifications.getPermissionsAsync();
      if (p.granted) return true;
      // iOS quiet delivery still delivers: provisional and ephemeral authorisations count.
      const ios = p.ios?.status;
      return (
        ios === Notifications.IosAuthorizationStatus.PROVISIONAL ||
        ios === Notifications.IosAuthorizationStatus.EPHEMERAL
      );
    },
    async scheduled() {
      const all = await Notifications.getAllScheduledNotificationsAsync();
      return all
        .filter((r) => isOurs(r.content.data))
        .map((r) => ({
          identifier: r.identifier,
          clientTripIds: (r.content.data as { clientTripIds: string[] }).clientTripIds,
        }));
    },
    async schedule(req) {
      if (os === 'android' && !channelReady) {
        await Notifications.setNotificationChannelAsync(DRIVE_SUMMARY_CHANNEL_ID, {
          name: startCopy.notification.channelName,
          importance: Notifications.AndroidImportance.DEFAULT,
        });
        channelReady = true;
      }
      await Notifications.scheduleNotificationAsync({
        identifier: req.identifier,
        content: {
          title: req.title,
          body: req.body,
          data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: req.clientTripIds },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: req.seconds,
          channelId: DRIVE_SUMMARY_CHANNEL_ID,
        },
      });
    },
    async cancel(identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier);
    },
  };
}

// ——— the rules ———

const DRIVING: ReadonlySet<EngineStatus> = new Set<EngineStatus>(['candidate', 'recording']);
const BUSY: ReadonlySet<EngineStatus> = new Set<EngineStatus>([
  'candidate',
  'recording',
  'ending',
  'finalizing',
]);

/** A finalize worth announcing: saved, long enough to score, and a drive at all. */
const announceable = (lf: LastFinalized): lf is Extract<LastFinalized, { ok: true }> =>
  lf !== null && lf.ok && !lf.short && lf.status !== 'discarded';

type HostLike = Pick<DriveHost, 'snapshot' | 'subscribe'>;

/** Every attached notifier, so a deletion or a handover can reach its carry. */
const liveNotifiers = new Set<{ forget(clientTripId?: string): Promise<void> }>();

/**
 * Cancel the drive-summary notification for a drive that is gone (m2): pass its `clientTripId`
 * when a drive is deleted; pass nothing on a handover or sign-out, which drops every pending
 * summary. Reaches both the OS's pending requests and each live notifier's in-memory carry. With
 * no notifier attached (a process that never mounted one) the OS requests are cancelled directly.
 */
export async function cancelDriveSummaries(
  clientTripId?: string,
  port: SummaryNotificationPort = createExpoSummaryPort()
): Promise<void> {
  if (liveNotifiers.size > 0) {
    await Promise.all([...liveNotifiers].map((n) => n.forget(clientTripId)));
    return;
  }
  const pending = await port.scheduled();
  for (const p of pending) {
    if (clientTripId === undefined || p.clientTripIds.includes(clientTripId)) {
      await port.cancel(p.identifier);
      // Without a notifier to re-schedule them, the other drives of a batch are left out rather
      // than announced by a request that also names a deleted drive.
    }
  }
}

const attached = new WeakMap<HostLike, { notifier: SummaryNotifier; refs: number }>();

/**
 * Watch `host` and schedule the drive-summary notification at each finalize. Idempotent per host:
 * the root layout's hook and the Android headless runtime may both attach; they share one notifier,
 * and it detaches when the last of them lets go.
 */
export function attachSummaryNotifier(
  host: HostLike,
  deps: SummaryNotifierDeps = {}
): SummaryNotifier {
  const existing = attached.get(host);
  if (existing) {
    existing.refs += 1;
    return handle(host, existing);
  }
  const entry = { notifier: createNotifier(host, deps), refs: 1 };
  attached.set(host, entry);
  return handle(host, entry);
}

function handle(
  host: HostLike,
  entry: { notifier: SummaryNotifier; refs: number }
): SummaryNotifier {
  let released = false;
  return {
    detach() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.notifier.detach();
        attached.delete(host);
      }
    },
    settled: () => entry.notifier.settled(),
  };
}

function createNotifier(host: HostLike, deps: SummaryNotifierDeps): SummaryNotifier {
  const port = deps.port ?? createExpoSummaryPort();
  const appState = deps.appState ?? AppState;
  const onEndScreen = deps.isEndScreenVisible ?? (() => endScreenVisible);
  const dailyCapAllows = deps.dailyCapAllows;
  const countsTowardCap = deps.countsTowardDailyCap ?? summaryCountsTowardDailyCap;
  const report = deps.onError ?? (() => {});
  let capGapReported = false;
  /** The cap's answer. Switch on and no counter wired → no (and say so once). */
  const capAllows = async (): Promise<boolean> => {
    if (!countsTowardCap()) return true;
    if (!dailyCapAllows) {
      if (!capGapReported) {
        capGapReported = true;
        report(
          new Error('drive summary counts toward the daily cap, but no dailyCapAllows was given'),
          'summary.cap'
        );
      }
      return false;
    }
    return dailyCapAllows();
  };

  // One serial chain for every OS call, so a cancel can never overtake the schedule before it.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (ctx: string, task: () => Promise<void>) => {
    chain = chain.then(task).catch((e: unknown) => report(e, ctx));
  };

  const initial = host.snapshot();
  let prevStatus: EngineStatus = initial.status;
  /** The trip this notifier saw being recorded: the only one whose outcome is news. */
  let watchedTripId: string | null = BUSY.has(initial.status) ? initial.clientTripId : null;
  /** A carried-over value from before the attach is not news. */
  let seenFinalized: LastFinalized = initial.lastFinalized;
  /** Drives awaiting their notification: cancelled by a new drive, or finalized mid-candidate. */
  let carried: string[] = [];

  const addCarried = (ids: readonly string[]) => {
    for (const id of ids) if (!carried.includes(id)) carried.push(id);
  };

  const cancelPending = () =>
    enqueue('summary.cancel', async () => {
      const pending = await port.scheduled();
      for (const p of pending) {
        addCarried(p.clientTripIds);
        await port.cancel(p.identifier);
      }
    });

  const scheduleCarried = (suppressed: boolean) => {
    if (suppressed) {
      // The driver is looking at the end screen right now: that screen is the answer, and the
      // drives it would have batched are one tap away on it and on Home.
      enqueue('summary.suppress', async () => {
        carried = [];
      });
      return;
    }
    enqueue('summary.schedule', scheduleCarriedNow);
  };

  /** Folds any pending request into the carry and schedules the carry as one request. */
  async function scheduleCarriedNow(): Promise<void> {
    if (carried.length === 0) return;
    if (!(await port.permissionGranted())) {
      carried = [];
      return;
    }
    if (!(await capAllows())) {
      carried = [];
      return;
    }
    // Re-read at the last moment: a drive may have begun while the reads above were in flight.
    if (DRIVING.has(host.snapshot().status)) return;
    const pending = await port.scheduled();
    addCarried(pending.flatMap((p) => p.clientTripIds));
    const ids = carried;
    carried = [];
    for (const p of pending) await port.cancel(p.identifier);
    const last = ids[ids.length - 1] as string;
    await port.schedule({
      identifier: `${IDENTIFIER_PREFIX}${last}`,
      clientTripIds: ids,
      seconds: DRIVE_SUMMARY_DELAY_S,
      ...summaryContent(ids),
    });
  }

  /**
   * m2: a drive that is gone (deleted, or wiped by a handover) is never announced. With an id,
   * that drive leaves every pending request and the carry, and any other drives in the same
   * request are scheduled again without it; with none, everything goes.
   */
  const forget = (clientTripId?: string) =>
    new Promise<void>((resolve) => {
      enqueue('summary.forget', async () => {
        try {
          const pending = await port.scheduled();
          const keep: string[] = [];
          for (const p of pending) {
            if (clientTripId !== undefined && !p.clientTripIds.includes(clientTripId)) continue;
            await port.cancel(p.identifier);
            if (clientTripId !== undefined) {
              keep.push(...p.clientTripIds.filter((id) => id !== clientTripId));
            }
          }
          carried =
            clientTripId === undefined ? [] : carried.filter((id) => id !== clientTripId);
          if (keep.length > 0) {
            addCarried(keep);
            if (!BUSY.has(host.snapshot().status)) await scheduleCarriedNow();
          }
        } finally {
          resolve();
        }
      });
    });

  const onChange = (s: DriveState) => {
    const status = s.status;
    const statusChanged = status !== prevStatus;
    const finalizedChanged = s.lastFinalized !== seenFinalized;
    // The 1 Hz path: a row changes neither, so it costs two comparisons.
    if (!statusChanged && !finalizedChanged) return;
    const wasBusy = BUSY.has(prevStatus);
    const wasDriving = DRIVING.has(prevStatus);
    prevStatus = status;

    if (finalizedChanged) {
      const lf = s.lastFinalized;
      seenFinalized = lf;
      if (lf !== null && lf.clientTripId === watchedTripId && announceable(lf) && !s.dryRun) {
        // Through the chain, so it lands after any cancel already queued: the batch keeps the
        // drives in the order they ended.
        const id = lf.clientTripId;
        enqueue('summary.carry', async () => addCarried([id]));
      }
      if (lf !== null && lf.clientTripId === watchedTripId) watchedTripId = null;
    }

    if (BUSY.has(status) && s.clientTripId !== null) watchedTripId = s.clientTripId;

    if (DRIVING.has(status) && !wasDriving) {
      cancelPending();
      return;
    }

    if (wasBusy && !BUSY.has(status)) {
      // Back to idle: the drive finalized, or the candidate was a false start. Read the foreground
      // and the end screen now, synchronously — the screen may route away within the frame.
      watchedTripId = null;
      scheduleCarried(appState.currentState === 'active' && onEndScreen());
    }
  };

  const unsubscribe = host.subscribe(onChange);
  const live = { forget };
  liveNotifiers.add(live);

  return {
    detach() {
      unsubscribe();
      liveNotifiers.delete(live);
    },
    settled: async () => {
      // Tasks may enqueue more tasks; wait until the chain stops growing.
      let seen: Promise<void> | null = null;
      while (seen !== chain) {
        seen = chain;
        await chain;
      }
    },
  };
}

// ——— routing a tap (used by useSummaryNotificationRouting) ———

/** Where a tapped drive-summary notification goes: one drive → its summary; a batch → the list. */
export function summaryHrefFor(response: Notifications.NotificationResponse | null): Href | null {
  if (!response) return null;
  const data = response.notification.request.content.data as unknown;
  if (!isOurs(data)) return null;
  const ids = data.clientTripIds.filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return null;
  return ids.length === 1 ? tripSummaryHref(ids[0] as string) : TRIP_HISTORY_HREF;
}
