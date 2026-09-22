/**
 * U3's drive-summary notifier with M4's delivery (Task 19). M3's rules — permission read never
 * asked, what is announced, the end-screen suppression, cancel on a new drive, the carry, batching,
 * deletion and handover — are unchanged and still tested here. M4's release gate is tested end to
 * end through the notifier over a real SQLite (sql.js): the catalog's copy, H6's summary switch,
 * quiet hours, the daily cap with the server's pushes, and a count that a batch never doubles.
 */
import * as Notifications from 'expo-notifications';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { createSettingsRepo, type Db } from '@/data/db';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { MILE_M, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import {
  attachSummaryNotifier,
  cancelDriveSummaries,
  createExpoSummaryPort,
  createSummaryDelivery,
  DRIVE_SUMMARY_KIND,
  LEGACY_SUMMARY_CHANNEL_ID,
  setEndScreenVisible,
  type ScheduledSummary,
  type SummaryDelivery,
  type SummaryNotificationPort,
  type SummaryRequest,
} from '@/features/drive/summaryNotifier';
import { createInboxCache } from '@/features/inbox/cache';
import { inboxRow, iso, lapseRow } from '@/features/inbox/__fixtures__/rows';
import { handleResponse } from '@/features/notifications/responses';
import { buildCatalog, NOTIFICATION_CATEGORIES, renderLocal } from '@/notifications/catalog';
import { LOCAL_SENT_KEY, PREFS_CACHE_KEY } from '@/notifications/keys';
import { LOCAL_LEDGER_KEY, SUMMARY_DELAY_MS, type EffectivePrefs } from '@/notifications/localDelivery';

// The inbox cache's module imports the app client; nothing here reaches the server.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  setNotificationChannelAsync: jest.fn(async () => null),
  deleteNotificationChannelAsync: jest.fn(async () => {}),
  setNotificationCategoryAsync: jest.fn(async () => null),
  dismissNotificationAsync: jest.fn(async () => {}),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  SchedulableTriggerInputTypes: { DATE: 'date', TIME_INTERVAL: 'timeInterval' },
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3, EPHEMERAL: 4 },
}));

/** Noon UTC, Monday 5 January 2026: outside the default quiet hours (22:00–07:00). */
const NOW = T0;
const AT = NOW + SUMMARY_DELAY_MS;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'armed',
    mode: 'mounted',
    role: 'driver',
    clientTripId: null,
    startedAt: null,
    lastRowTs: null,
    speedMps: 0,
    speedKnown: false,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: false,
    stoppedPanel: false,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 0,
    dryRun: false,
    ...over,
  };
}

function stubHost(initial: DriveState) {
  let current = initial;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isBusy: () => ['candidate', 'recording', 'ending', 'finalizing'].includes(current.status),
  } as unknown as DriveHost;
  return {
    host,
    push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      for (const fn of listeners) fn(current);
    },
    listeners: () => listeners.size,
  };
}

/**
 * The OS's pending-request list, in memory. Like the OS, it stops listing a request once its time
 * has come (delivered); `pending()` is every request ever left in place, for assertions.
 */
function fakePort(opts: { granted?: boolean } = {}) {
  let pending: SummaryRequest[] = [];
  const port: SummaryNotificationPort & { pending: () => SummaryRequest[] } = {
    permissionGranted: jest.fn(async () => opts.granted ?? true),
    scheduled: jest.fn(async (): Promise<ScheduledSummary[]> =>
      pending
        .filter((p) => p.at > clock)
        .map(({ identifier, clientTripIds }) => ({ identifier, clientTripIds }))
    ),
    schedule: jest.fn(async (req: SummaryRequest) => {
      pending = [...pending.filter((p) => p.identifier !== req.identifier), req];
    }),
    cancel: jest.fn(async (id: string) => {
      pending = pending.filter((p) => p.identifier !== id);
    }),
    pending: () => pending,
  };
  return port;
}

const ok = (id: string, over: Partial<{ short: boolean; status: 'provisional' | 'unscored' | 'discarded' }> = {}): LastFinalized => ({
  clientTripId: id,
  ok: true,
  status: over.status ?? 'provisional',
  short: over.short ?? false,
  at: NOW,
});

const background = { currentState: 'background' as string | null };

/** Drive trip `id` from recording through finalize to armed with the given outcome. */
function drive(h: ReturnType<typeof stubHost>, id: string, outcome: LastFinalized) {
  h.push({ status: 'candidate', clientTripId: id });
  h.push({ status: 'recording' });
  h.push({ status: 'finalizing' });
  h.push({ status: 'armed', clientTripId: null, lastFinalized: outcome });
}

/** `renderLocal` for a drive this phone does not hold: no distance, no question. */
const single = (id: string) =>
  renderLocal('trip_summary', { clientTripId: id, distanceM: 0, roleUnknown: false, scorableIfDriver: false, count: 1 });
const batch = (ids: string[]) =>
  renderLocal('trip_summary', {
    clientTripId: ids[ids.length - 1] as string,
    distanceM: 0,
    roleUnknown: false,
    scorableIfDriver: false,
    count: ids.length,
  });

let db: Db;
let clock: number;
let delivery: SummaryDelivery;

beforeEach(async () => {
  db = await createTestDb();
  clock = NOW;
  delivery = createSummaryDelivery(db, { zone: () => 'UTC' });
});

afterEach(() => {
  setEndScreenVisible(false);
  jest.clearAllMocks();
});

/** A notifier over the real delivery on `db`, in the background, at `clock`. */
function attach(h: ReturnType<typeof stubHost>, port: SummaryNotificationPort, over: Record<string, unknown> = {}) {
  return attachSummaryNotifier(h.host, { port, delivery, now: () => clock, appState: background, ...over });
}

const settings = () => createSettingsRepo(db);
const localSent = () => settings().get<{ day: string; count: number }>(LOCAL_SENT_KEY);

async function setPrefs(over: { trip_summaries?: boolean; quiet?: EffectivePrefs['quiet'] } = {}) {
  const prefs: EffectivePrefs = {
    categories: {
      ...(Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])) as EffectivePrefs['categories']),
      trip_summaries: over.trip_summaries ?? true,
    },
    quiet: over.quiet ?? { enabled: false, start: '22:00', end: '07:00' },
  };
  await settings().set(PREFS_CACHE_KEY, prefs);
}

describe('M3 rules, unchanged', () => {
  test('at finalize, in the background, with permission: one notification, 120 s after, no score and no places', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toEqual([
      { identifier: 'drive-summary:t1', clientTripIds: ['t1'], copy: single('t1'), at: AT },
    ]);
    expect(port.pending()[0]?.copy.body).not.toMatch(/score|\d+ ?pts|near|street/i);
    n.detach();
  });

  test('never asks for permission; without it nothing is scheduled', async () => {
    const h = stubHost(state());
    const port = fakePort({ granted: false });
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled(); // the fake port was used
    expect(await localSent()).toBeNull();
    n.detach();
  });

  test('skips a short drive, a discarded drive, a failed save and a dry run', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 'short', ok('short', { short: true }));
    drive(h, 'train', ok('train', { status: 'discarded' }));
    drive(h, 'fail', { clientTripId: 'fail', ok: false, at: NOW });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n.detach();

    const dry = stubHost(state({ dryRun: true }));
    const n2 = attach(dry, port);
    drive(dry, 'sim', ok('sim'));
    await n2.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n2.detach();
  });

  test('an unscored drive (a passenger, or who-was-driving) still gets one: it is ready to look at', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 'p', ok('p', { status: 'unscored' }));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('not while the app is in the foreground on the end screen — the screen itself is the answer', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const appState = { currentState: 'active' as string | null };
    const n = attach(h, port, { appState });
    setEndScreenVisible(true);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();

    // The end screen showing while the app is in the background does not count.
    appState.currentState = 'background';
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending().map((p) => p.clientTripIds)).toEqual([['t2']]);
    n.detach();
  });

  test('foreground elsewhere in the app (an auto drive ending while Home is open) still schedules', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port, { appState: { currentState: 'active' } });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('a new candidate cancels the pending notification; so does recording', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    h.push({ status: 'candidate', clientTripId: 't2' });
    await n.settled();
    expect(port.pending()).toHaveLength(0);
    n.detach();

    const r = stubHost(state());
    const port2 = fakePort();
    const n2 = attach(r, port2);
    drive(r, 't3', ok('t3'));
    await n2.settled();
    expect(port2.pending()).toHaveLength(1);
    // A rowless resume straight into recording (the engine can skip candidate).
    r.push({ status: 'recording', clientTripId: 't4' });
    await n2.settled();
    expect(port2.pending()).toHaveLength(0);
    n2.detach();
  });

  test('a second finalize before it fires replaces it with one batched notification', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    // The next drive starts inside the 120 s: the first request is cancelled, not forgotten.
    clock = NOW + 60_000;
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending()).toEqual([
      {
        identifier: 'drive-summary:t2',
        clientTripIds: ['t1', 't2'],
        copy: batch(['t1', 't2']),
        at: clock + SUMMARY_DELAY_MS,
      },
    ]);
    expect(port.pending()[0]?.copy).toMatchObject({ title: '2 drives are ready', url: '/trips' });
    n.detach();
  });

  test('a false start (a candidate that is discarded) gives the cancelled notification back, 120 s on', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    h.push({ status: 'candidate', clientTripId: 'walk' });
    await n.settled();
    expect(port.pending()).toHaveLength(0);
    clock = NOW + 90_000;
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.pending()).toEqual([
      expect.objectContaining({ clientTripIds: ['t1'], at: clock + SUMMARY_DELAY_MS }),
    ]);
    n.detach();
  });

  test('a short drive after a pending one: the pending one comes back alone', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    drive(h, 'hop', ok('hop', { short: true }));
    await n.settled();
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t1'], copy: single('t1') })]);
    n.detach();
  });

  test('a finalize that lands while the next candidate is already open waits for that drive to end', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    h.push({ status: 'recording', clientTripId: 't1' });
    h.push({ status: 'finalizing' });
    // Post-gap self-dispatch: finalize → armed → a new candidate inside one host task.
    h.push({ status: 'candidate', clientTripId: 't2', lastFinalized: ok('t1') });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    h.push({ status: 'armed', clientTripId: null }); // the candidate was discarded
    await n.settled();
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t1'] })]);
    n.detach();
  });

  test('a lastFinalized carried over from an earlier trip is never announced again', async () => {
    const h = stubHost(state({ lastFinalized: ok('old') }));
    const port = fakePort();
    const n = attach(h, port);
    h.push({ speedMps: 1 });
    h.push({ status: 'candidate', clientTripId: 'false-start' });
    h.push({ status: 'armed', clientTripId: null }); // discarded candidate: lastFinalized unchanged
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();

    h.push({ lastFinalized: ok('someone-else') });
    h.push({ status: 'candidate', clientTripId: 'another-false-start' });
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();

    h.push({ status: 'recording', clientTripId: 'mine' });
    h.push({ lastFinalized: ok('not-mine') });
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n.detach();
  });

  test('a drive adopted after a relaunch is watched from the attach', async () => {
    const h = stubHost(state({ status: 'recording', clientTripId: 'adopted' }));
    const port = fakePort();
    const n = attach(h, port);
    h.push({ status: 'finalizing' });
    h.push({ status: 'armed', clientTripId: null, lastFinalized: ok('adopted') });
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('two attaches to one host share one notifier (the runtime and the headless task)', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const a = attach(h, port);
    // The headless task attaches with no deps of its own: it shares the runtime's delivery.
    const b = attachSummaryNotifier(h.host);
    expect(h.listeners()).toBe(1);
    drive(h, 't1', ok('t1'));
    await a.settled();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(await localSent()).toEqual({ day: '2026-01-05', count: 1 });
    a.detach();
    expect(h.listeners()).toBe(1);
    b.detach();
    expect(h.listeners()).toBe(0);
  });

  test('the 1 Hz path costs nothing: rows while recording make no port call and no database read', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const plan = jest.spyOn(delivery, 'plan');
    const n = attach(h, port);
    h.push({ status: 'recording', clientTripId: 't1' });
    await n.settled();
    (port.scheduled as jest.Mock).mockClear();
    (port.cancel as jest.Mock).mockClear();
    for (let i = 0; i < 60; i++) h.push({ speedMps: i, lastRowTs: NOW + i * 1000 });
    await n.settled();
    expect(port.scheduled).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    n.detach();
  });

  test('m2: a deleted drive leaves its pending notification; the rest of a batch is announced without it', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending()[0]?.clientTripIds).toEqual(['t1', 't2']);
    await cancelDriveSummaries('t1');
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t2'], copy: single('t2') })]);
    expect((await localSent())?.count).toBe(1);
    await cancelDriveSummaries('t2');
    expect(port.pending()).toEqual([]);
    expect((await localSent())?.count).toBe(0);
    n.detach();
  });

  test('m2: a drive deleted while carried (cancelled by the next drive) is never announced', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    h.push({ status: 'candidate', clientTripId: 't2' });
    await n.settled();
    await cancelDriveSummaries('t1');
    h.push({ status: 'armed', clientTripId: null }); // a false start: the carry would come back
    await n.settled();
    expect(port.pending()).toEqual([]);
    n.detach();
  });

  test('m2: a handover or sign-out drops every pending summary and the carry', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    h.push({ status: 'candidate', clientTripId: 't2' });
    await n.settled();
    await cancelDriveSummaries();
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.pending()).toEqual([]);
    n.detach();
  });

  test('m2 negative control: deleting an unrelated drive leaves a pending notification alone', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    await cancelDriveSummaries('other');
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t1'] })]);
    n.detach();
  });

  test('m2: with no notifier attached, the OS requests naming the drive are cancelled directly', async () => {
    const port = fakePort();
    await port.schedule({ identifier: 'drive-summary:a', clientTripIds: ['a'], copy: single('a'), at: AT });
    await port.schedule({ identifier: 'drive-summary:b', clientTripIds: ['b'], copy: single('b'), at: AT });
    await cancelDriveSummaries('a', port);
    expect(port.pending().map((p) => p.identifier)).toEqual(['drive-summary:b']);
    await cancelDriveSummaries(undefined, port);
    expect(port.pending()).toEqual([]);
  });
});

describe('M4: one copy, H6, quiet hours and the cap (the release gate)', () => {
  test('the words are the catalog’s: a who-drove drive asks, with the role buttons and the scoring promise', async () => {
    await seedTrips(db, [tripRow({ client_trip_id: 'q1', role: 'unknown', status: 'unscored', score: null })]);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 'q1', ok('q1', { status: 'unscored' }));
    await n.settled();
    const expected = renderLocal('trip_summary', {
      clientTripId: 'q1',
      distanceM: 10 * MILE_M,
      roleUnknown: true,
      scorableIfDriver: true,
      count: 1,
    });
    expect(port.pending()[0]?.copy).toEqual(expected);
    expect(expected).toMatchObject({
      title: 'Were you driving?',
      body: 'Tell us who drove your 10 mi trip so it can be scored.',
      categoryId: 'trip_role',
      url: '/trips/q1/summary',
      channelId: 'trips',
    });
    n.detach();
  });

  test('a who-drove drive that could not be scored anyway (grade C data) makes no scoring promise', async () => {
    await seedTrips(db, [
      tripRow({ client_trip_id: 'q2', role: 'unknown', status: 'unscored', score: null, data_quality: 'C' }),
    ]);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 'q2', ok('q2', { status: 'unscored' }));
    await n.settled();
    expect(port.pending()[0]?.copy.body).toBe('Tell us who drove your 10 mi trip.');
    n.detach();
  });

  test('a known-driver drive: "Drive summary ready" with its distance, no buttons', async () => {
    await seedTrips(db, [tripRow({ client_trip_id: 'd1' })]);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 'd1', ok('d1'));
    await n.settled();
    expect(port.pending()[0]?.copy).toEqual({
      title: 'Drive summary ready',
      body: 'Your 10 mi drive is ready. Tap to see how it went.',
      url: '/trips/d1/summary',
      channelId: 'trips',
    });
    n.detach();
  });

  test('H6 "Drive summaries" off: nothing is scheduled and nothing counted', async () => {
    await setPrefs({ trip_summaries: false });
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    expect((await localSent())?.count ?? 0).toBe(0);
    expect(await settings().get(LOCAL_LEDGER_KEY)).toEqual([]);
    // And the carry is spent, not held for a later drive.
    await setPrefs({ trip_summaries: true });
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending().map((p) => p.clientTripIds)).toEqual([['t2']]);
    n.detach();
  });

  test('quiet hours: a drive ending at 23:00 is announced at the quiet end, 07:00, and counted on that day', async () => {
    await setPrefs({ quiet: { enabled: true, start: '22:00', end: '07:00' } });
    clock = Date.UTC(2026, 0, 5, 23, 0, 0);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()[0]?.at).toBe(Date.UTC(2026, 0, 6, 7, 0, 0));
    expect(await localSent()).toEqual({ day: '2026-01-05', count: 0 });
    expect(await settings().get(LOCAL_LEDGER_KEY)).toEqual([
      { id: 'drive-summary:t1', at: Date.UTC(2026, 0, 6, 7, 0, 0), day: '2026-01-06' },
    ]);
    n.detach();
  });

  test('the cap: two already shown today (local) means the third summary is not scheduled', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    clock = NOW + 60 * 60_000; // an hour later: t1 has been delivered
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect((await localSent())?.count).toBe(2);
    clock = NOW + 2 * 60 * 60_000;
    (port.schedule as jest.Mock).mockClear();
    drive(h, 't3', ok('t3'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n.detach();
  });

  test('the cap counts the server’s pushes from the inbox cache: one local and one push today is the cap', async () => {
    await createInboxCache(db).replaceAll([
      lapseRow({ id: '00000000-0000-4000-8000-000000000001', pushed_at: iso(NOW - 60_000) }),
    ]);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    clock = NOW + 60 * 60_000;
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending().map((p) => p.clientTripIds)).toEqual([['t1']]);
    expect(port.schedule).toHaveBeenCalledTimes(1);
    n.detach();
  });

  test('a push from yesterday, or one never pushed, is not today’s', async () => {
    await createInboxCache(db).replaceAll([
      lapseRow({ id: '00000000-0000-4000-8000-000000000001', pushed_at: iso(NOW - 86_400_000) }),
      inboxRow({ id: '00000000-0000-4000-8000-000000000002', pushed_at: null }),
    ]);
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    clock = NOW + 60 * 60_000;
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.schedule).toHaveBeenCalledTimes(2);
    n.detach();
  });

  test('a batch counts once: the replaced request is uncounted before its replacement is counted', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect((await localSent())?.count).toBe(1);
    clock = NOW + 60_000;
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(await localSent()).toEqual({ day: '2026-01-05', count: 1 });
    expect(await settings().get(LOCAL_LEDGER_KEY)).toEqual([
      { id: 'drive-summary:t2', at: clock + SUMMARY_DELAY_MS, day: '2026-01-05' },
    ]);
    n.detach();
  });

  test('a cancel before delivery (the next drive begins) uncounts; a delivered one stays counted', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    drive(h, 't1', ok('t1'));
    await n.settled();
    h.push({ status: 'candidate', clientTripId: 't2' });
    await n.settled();
    expect((await localSent())?.count).toBe(0);
    h.push({ status: 'armed', clientTripId: null }); // a false start: t1 comes back, counted again
    await n.settled();
    expect((await localSent())?.count).toBe(1);

    // Delivered (its time has passed), then a drive begins: the OS no longer lists it, so nothing
    // is cancelled and it stays counted.
    clock = AT + 1_000;
    h.push({ status: 'candidate', clientTripId: 't3' });
    await n.settled();
    expect((await localSent())?.count).toBe(1);
    n.detach();
  });

  test('with the summary ruled transactional (buildCatalog(false)) it is never capped and never counted', async () => {
    delivery = createSummaryDelivery(db, { zone: () => 'UTC', catalog: buildCatalog(false) });
    const h = stubHost(state());
    const port = fakePort();
    const n = attach(h, port);
    for (let i = 1; i <= 3; i++) {
      clock = NOW + i * 60 * 60_000;
      drive(h, `t${i}`, ok(`t${i}`));
      await n.settled();
    }
    expect(port.schedule).toHaveBeenCalledTimes(3);
    expect(await settings().get(LOCAL_LEDGER_KEY)).toEqual([]);
    expect((await localSent())?.count).toBe(0);
    n.detach();
  });

  test('no database and no delivery: fails closed and says so once', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const onError = jest.fn();
    const n = attachSummaryNotifier(h.host, { port, appState: background, onError });
    drive(h, 't1', ok('t1'));
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'summary.delivery');
    n.detach();
  });

  test('the default delivery takes the db: attached with { db }, it schedules and counts', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, db, now: () => clock, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });
});

describe('createExpoSummaryPort', () => {
  const req = (over: Partial<SummaryRequest> = {}): SummaryRequest => ({
    identifier: 'drive-summary:t1',
    clientTripIds: ['t1'],
    copy: single('t1'),
    at: AT,
    ...over,
  });

  test('after the channels and category exist, schedules at the plan’s time on `trips`, with the url for routing', async () => {
    const port = createExpoSummaryPort('android');
    await port.schedule(req());
    expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalled();
    expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledWith(LEGACY_SUMMARY_CHANNEL_ID);
    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalledWith(LEGACY_SUMMARY_CHANNEL_ID, expect.anything());
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'drive-summary:t1',
      content: {
        title: 'Drive summary ready',
        body: 'Your drive is ready. Tap to see how it went.',
        data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: ['t1'], url: '/trips/t1/summary' },
      },
      trigger: { type: 'date', date: AT, channelId: 'trips' },
    });
    // The retired channel is deleted once per process, not at every schedule.
    await port.schedule(req({ identifier: 'drive-summary:t2' }));
    expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledTimes(1);
  });

  test('the who-drove variant carries the trip_role category', async () => {
    const copy = renderLocal('trip_summary', {
      clientTripId: 't1',
      distanceM: 0,
      roleUnknown: true,
      scorableIfDriver: false,
      count: 1,
    });
    await createExpoSummaryPort('ios').schedule(req({ copy }));
    const call = (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls[0]?.[0] as {
      content: { categoryIdentifier?: string };
    };
    expect(call.content.categoryIdentifier).toBe('trip_role');
    expect(Notifications.deleteNotificationChannelAsync).not.toHaveBeenCalled();
  });

  test('a tap on the scheduled summary navigates exactly once, to its url (Task 5 routing)', async () => {
    await createExpoSummaryPort('ios').schedule(req());
    const { content } = (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls[0]?.[0] as {
      content: { title: string; body: string; data: unknown };
    };
    const navigate = jest.fn();
    const out = await handleResponse(
      {
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        notification: { date: 1, request: { identifier: 'drive-summary:t1', content, trigger: null } },
      } as never,
      { db, navigate, isBusy: () => false, now: () => clock }
    );
    expect(out).toEqual({ kind: 'navigated', href: '/trips/t1/summary' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/trips/t1/summary');
  });

  test('reads only its own pending requests', async () => {
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValueOnce([
      { identifier: 'drive-summary:a', content: { data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: ['a'], url: '/trips/a/summary' } } },
      { identifier: 'other', content: { data: { kind: 'somethingElse' } } },
      { identifier: 'bare', content: { data: null } },
    ]);
    await expect(createExpoSummaryPort('ios').scheduled()).resolves.toEqual([
      { identifier: 'drive-summary:a', clientTripIds: ['a'] },
    ]);
  });

  test('permission is read, never requested; iOS provisional counts as granted', async () => {
    const port = createExpoSummaryPort('ios');
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false, status: 'denied' });
    await expect(port.permissionGranted()).resolves.toBe(false);
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      granted: false,
      status: 'granted',
      ios: { status: 3 },
    });
    await expect(port.permissionGranted()).resolves.toBe(true);
    expect(Notifications).not.toHaveProperty('requestPermissionsAsync');
  });
});
