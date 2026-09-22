/**
 * The "your drive is ready" notification (§11.2 "Trip summary ready"; cross-plan ruling: LOCAL,
 * scheduled on the phone at finalize, never pushed by the server for this device's own trips).
 *
 * The rules (M3 brief U3, rev1: I14), unchanged by M4:
 * - At finalize, one local notification with an OS trigger. No JS timer is involved: iOS suspends a
 *   backgrounded app, so the OS holds the delay.
 * - Only when notification permission is ALREADY granted. This module never asks.
 * - Never for a short, discarded, failed or simulated drive, and never while the app is in the
 *   foreground on the end screen (that screen is the answer).
 * - A new candidate or recording cancels the pending request, so nothing lands while driving.
 *   The cancelled drive is carried, not forgotten: when that next drive ends — or turns out to be
 *   a false start — the carried drive is announced again, batched with the new one when it
 *   qualifies ("2 drives are ready").
 *
 * M4 (Task 19; rev1: C1): the words, the link and the "Were you driving?" buttons come from the
 * catalog's `renderLocal` (one copy). Whether and when come from `localDeliveryPlan`: H6's "Drive
 * summaries" switch, quiet hours (the trigger moves to the quiet end) and the §11.1 daily cap,
 * counted together with the server's pushes from the inbox cache. A scheduled summary is counted
 * (`recordLocalSent`) on its delivery day; one cancelled or replaced before delivery is uncounted
 * (`uncountLocalSent`), so a batch never counts twice. It goes on the `trips` channel, after
 * `ensureNotificationSetup()` (the channels and the `trip_role` category).
 *
 * Honesty: a `lastFinalized` carries over into the next trip (H1 review), so an outcome is only
 * news when its `clientTripId` is the trip this notifier watched being recorded.
 *
 * Battery (§3.5): the host listener compares two fields per change and returns. The OS and the
 * database are touched only on a status edge or a finalize — never on the 1 Hz path, and never
 * while armed and idle.
 */
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import type { EngineStatus } from '@/core/engine/engine.types';
import { normaliseZone } from '@/core/engine/finalize';
import { readConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import { toTripSummary } from '@/data/queries/rows';
import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { isBusyStatus, isDrivingStatus } from '@/drive/policy';
import { countServerPushesToday, scorableIfDriver } from '@/features/inbox/viewModel';
import { ensureNotificationSetup } from '@/features/notifications/categories';
import { renderLocal, type Catalog, type LocalCopy, type TripSummaryFacts } from '@/notifications/catalog';
import {
  localDeliveryPlan,
  readCachedPrefs,
  readLocalCounts,
  recordLocalSent,
  uncountLocalSent,
  type LocalPlan,
} from '@/notifications/localDelivery';

/** `content.data.kind` of every drive-summary request, so cancels find only ours (and T5's legacy routing). */
export const DRIVE_SUMMARY_KIND = 'driveSummary';
/** M3's own channel, retired: summaries go on the catalog's `trips` channel (Task 5). */
export const LEGACY_SUMMARY_CHANNEL_ID = 'drive-summary';
const IDENTIFIER_PREFIX = 'drive-summary:';

export interface ScheduledSummary {
  identifier: string;
  clientTripIds: string[];
}

/** One OS request: `renderLocal`'s copy, delivered at `at` (epoch ms). */
export interface SummaryRequest extends ScheduledSummary {
  copy: LocalCopy;
  at: number;
}

/** Everything this module asks of the OS. */
export interface SummaryNotificationPort {
  /** Read only — never prompts. */
  permissionGranted(): Promise<boolean>;
  /** Our pending (not yet delivered) requests. */
  scheduled(): Promise<ScheduledSummary[]>;
  schedule(req: SummaryRequest): Promise<void>;
  cancel(identifier: string): Promise<void>;
}

/**
 * The M4 half: what a summary says, whether and when it may be shown, and its count. The default,
 * `createSummaryDelivery(db)`, reads the phone's own database.
 */
export interface SummaryDelivery {
  /** `renderLocal` for these drives: one from its trip row, several as the batch. */
  render(clientTripIds: readonly string[]): Promise<LocalCopy>;
  /** `localDeliveryPlan` for a summary of drives that ended at `endedAt`. */
  plan(endedAt: number, now: number): Promise<LocalPlan>;
  /** Counts a scheduled request on its delivery day. */
  record(identifier: string, at: number, now: number): Promise<void>;
  /** Uncounts a request cancelled before delivery. One already delivered stays counted. */
  uncount(identifier: string, now: number): Promise<void>;
}

export interface SummaryNotifierDeps {
  port?: SummaryNotificationPort;
  /** The database the default delivery reads. With neither this nor `delivery`, nothing is scheduled. */
  db?: Db;
  delivery?: SummaryDelivery;
  now?: () => number;
  appState?: { currentState: string | null };
  isEndScreenVisible?: () => boolean;
  onError?: (e: unknown, ctx: string) => void;
}

export interface SummaryNotifier {
  detach(): void;
  /** Resolves once every OS call queued so far has finished (tests, shutdown). */
  settled(): Promise<void>;
}

// ——— the M4 delivery, from the phone's database ———

/** The phone's zone, normalised the way a drive's zone is. */
function deviceZone(): string {
  try {
    return normaliseZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'UTC';
  }
}

/**
 * The facts `renderLocal` needs for one drive. `scorableIfDriver` re-runs the scoring gate with
 * role `driver` (ruling T4 I2). A drive this phone no longer holds makes no claim: no distance, no
 * question and no scoring promise.
 */
async function factsFor(db: Db, clientTripId: string): Promise<TripSummaryFacts> {
  const row = await createTripsRepo(db).get(clientTripId);
  if (row === null) {
    return { clientTripId, distanceM: 0, roleUnknown: false, scorableIfDriver: false, count: 1 };
  }
  const trip = toTripSummary(row);
  const roleUnknown = trip.role === 'unknown';
  return {
    clientTripId,
    distanceM: trip.distanceM,
    roleUnknown,
    scorableIfDriver: roleUnknown && scorableIfDriver(trip),
    count: 1,
  };
}

export function createSummaryDelivery(
  db: Db,
  opts: { zone?: () => string; /** Tests build both readings of the cap question. */ catalog?: Catalog } = {}
): SummaryDelivery {
  const settings = createSettingsRepo(db);
  const zone = () => normaliseZone((opts.zone ?? deviceZone)());
  return {
    async render(ids) {
      const last = ids[ids.length - 1] as string;
      if (ids.length >= 2) {
        return renderLocal('trip_summary', {
          clientTripId: last,
          distanceM: 0,
          roleUnknown: false,
          scorableIfDriver: false,
          count: ids.length,
        });
      }
      return renderLocal('trip_summary', await factsFor(db, last));
    },
    async plan(endedAt, now) {
      const tz = zone();
      const prefs = await readCachedPrefs(settings, (await readConfig(db)).notification_defaults);
      const { today, byDay } = await readLocalCounts(settings, tz, now);
      // The server's half, from the inbox cache, never the screen's hook, which is 0 until its
      // query resolves (T6 review m3). Required here: the inbox cache's module loads the app client.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred, see above
      const { createInboxCache } = require('@/features/inbox/cache') as typeof import('@/features/inbox/cache');
      const rows = await createInboxCache(db).list();
      const serverPushedToday = countServerPushesToday(rows, tz, now, opts.catalog);
      return localDeliveryPlan({
        type: 'trip_summary',
        endedAt,
        now,
        prefs,
        tz,
        localSentToday: today.count,
        serverPushedToday,
        localScheduledByDay: byDay,
        catalog: opts.catalog,
      });
    },
    async record(identifier, at, now) {
      await recordLocalSent(settings, zone(), now, { id: identifier, at, catalog: opts.catalog });
    },
    async uncount(identifier, now) {
      await uncountLocalSent(settings, identifier, zone(), now);
    },
  };
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
  let legacyChannelGone = false;
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
      // The `trips` channel and the "Were you driving?" buttons exist before the first request.
      await ensureNotificationSetup();
      if (os === 'android' && !legacyChannelGone) {
        legacyChannelGone = true;
        await Notifications.deleteNotificationChannelAsync(LEGACY_SUMMARY_CHANNEL_ID).catch(() => {});
      }
      const { copy } = req;
      await Notifications.scheduleNotificationAsync({
        identifier: req.identifier,
        content: {
          title: copy.title,
          body: copy.body,
          // `url` is what a tap opens (Task 5's routing); the kind and ids let cancels find it.
          data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: req.clientTripIds, url: copy.url },
          ...(copy.categoryId === undefined ? {} : { categoryIdentifier: copy.categoryId }),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: req.at,
          channelId: copy.channelId,
        },
      });
    },
    async cancel(identifier) {
      await Notifications.cancelScheduledNotificationAsync(identifier);
    },
  };
}

// ——— the rules ———

// The status sets are policy's, one copy for the app (final review M10b).

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
 * the runtime and the Android headless task may both attach; they share one notifier (made with
 * the first attach's deps), and it detaches when the last of them lets go.
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
  const delivery = deps.delivery ?? (deps.db ? createSummaryDelivery(deps.db) : null);
  const now = deps.now ?? Date.now;
  const appState = deps.appState ?? AppState;
  const onEndScreen = deps.isEndScreenVisible ?? (() => endScreenVisible);
  const report = deps.onError ?? (() => {});
  let deliveryGapReported = false;

  // One serial chain for every OS call, so a cancel can never overtake the schedule before it.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (ctx: string, task: () => Promise<void>) => {
    chain = chain.then(task).catch((e: unknown) => report(e, ctx));
  };

  const initial = host.snapshot();
  let prevStatus: EngineStatus = initial.status;
  /** The trip this notifier saw being recorded: the only one whose outcome is news. */
  let watchedTripId: string | null = isBusyStatus(initial.status) ? initial.clientTripId : null;
  /** A carried-over value from before the attach is not news. */
  let seenFinalized: LastFinalized = initial.lastFinalized;
  /** Drives awaiting their notification: cancelled by a new drive, or finalized mid-candidate. */
  let carried: string[] = [];

  const addCarried = (ids: readonly string[]) => {
    for (const id of ids) if (!carried.includes(id)) carried.push(id);
  };

  /** Cancel a pending request and take it off the day's count (it was never delivered). */
  const cancelOne = async (identifier: string) => {
    await port.cancel(identifier);
    if (delivery) {
      await delivery.uncount(identifier, now()).catch((e: unknown) => report(e, 'summary.uncount'));
    }
  };

  const cancelPending = () =>
    enqueue('summary.cancel', async () => {
      const pending = await port.scheduled();
      for (const p of pending) {
        addCarried(p.clientTripIds);
        await cancelOne(p.identifier);
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
    if (!delivery) {
      // No way to honour H6 and the cap: fail closed, and say so once.
      carried = [];
      if (!deliveryGapReported) {
        deliveryGapReported = true;
        report(new Error('drive summary notifier has no database to plan delivery'), 'summary.delivery');
      }
      return;
    }
    if (!(await port.permissionGranted())) {
      carried = [];
      return;
    }
    // Re-read at the last moment: a drive may have begun while the read above was in flight.
    if (isDrivingStatus(host.snapshot().status)) return;
    const pending = await port.scheduled();
    addCarried(pending.flatMap((p) => p.clientTripIds));
    const ids = carried;
    carried = [];
    // The replaced requests come off the count first, so the batch that replaces them counts once.
    for (const p of pending) await cancelOne(p.identifier);
    const t = now();
    const plan = await delivery.plan(t, t);
    if (plan.kind === 'skip') return;
    const copy = await delivery.render(ids);
    const identifier = `${IDENTIFIER_PREFIX}${ids[ids.length - 1] as string}`;
    await port.schedule({ identifier, clientTripIds: ids, copy, at: plan.at });
    await delivery.record(identifier, plan.at, t);
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
            await cancelOne(p.identifier);
            if (clientTripId !== undefined) {
              keep.push(...p.clientTripIds.filter((id) => id !== clientTripId));
            }
          }
          carried =
            clientTripId === undefined ? [] : carried.filter((id) => id !== clientTripId);
          if (keep.length > 0) {
            addCarried(keep);
            if (!isBusyStatus(host.snapshot().status)) await scheduleCarriedNow();
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
    const wasBusy = isBusyStatus(prevStatus);
    const wasDriving = isDrivingStatus(prevStatus);
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

    if (isBusyStatus(status) && s.clientTripId !== null) watchedTripId = s.clientTripId;

    if (isDrivingStatus(status) && !wasDriving) {
      cancelPending();
      return;
    }

    if (wasBusy && !isBusyStatus(status)) {
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
