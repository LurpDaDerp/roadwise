import * as Notifications from 'expo-notifications';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import {
  attachSummaryNotifier,
  cancelDriveSummaries,
  createExpoSummaryPort,
  DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP,
  DRIVE_SUMMARY_DELAY_S,
  DRIVE_SUMMARY_KIND,
  setEndScreenVisible,
  summaryContent,
  summaryCountsTowardDailyCap,
  summaryHrefFor,
  type ScheduledSummary,
  type SummaryNotificationPort,
} from '@/features/drive/summaryNotifier';
import { TRIP_HISTORY_HREF, tripSummaryHref } from '@/features/trips/routes';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  setNotificationChannelAsync: jest.fn(async () => null),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3, EPHEMERAL: 4 },
}));

const T = 1_700_000_000_000;

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

/** The OS's pending-request list, in memory. */
function fakePort(opts: { granted?: boolean } = {}) {
  let pending: (ScheduledSummary & { title: string; body: string; seconds: number })[] = [];
  const port: SummaryNotificationPort & { pending: () => typeof pending } = {
    permissionGranted: jest.fn(async () => opts.granted ?? true),
    scheduled: jest.fn(async () => pending.map(({ identifier, clientTripIds }) => ({ identifier, clientTripIds }))),
    schedule: jest.fn(async (req) => {
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
  at: T,
});

const background = { currentState: 'background' as string | null };

/** Drive trip `id` from recording through finalize to armed with the given outcome. */
function drive(h: ReturnType<typeof stubHost>, id: string, outcome: LastFinalized) {
  h.push({ status: 'candidate', clientTripId: id });
  h.push({ status: 'recording' });
  h.push({ status: 'finalizing' });
  h.push({ status: 'armed', clientTripId: null, lastFinalized: outcome });
}

afterEach(() => {
  setEndScreenVisible(false);
  jest.clearAllMocks();
});

describe('attachSummaryNotifier', () => {
  test('at finalize, in the background, with permission: one notification, 120 s after, no score and no places', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toEqual([
      {
        identifier: 'drive-summary:t1',
        title: 'Your drive is ready',
        body: 'Tap to see how it went',
        clientTripIds: ['t1'],
        seconds: DRIVE_SUMMARY_DELAY_S,
      },
    ]);
    expect(DRIVE_SUMMARY_DELAY_S).toBe(120);
    n.detach();
  });

  test('never asks for permission; without it nothing is scheduled', async () => {
    const h = stubHost(state());
    const port = fakePort({ granted: false });
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled(); // the fake port was used
    n.detach();
  });

  test('skips a short drive, a discarded drive, a failed save and a dry run', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 'short', ok('short', { short: true }));
    drive(h, 'train', ok('train', { status: 'discarded' }));
    drive(h, 'fail', { clientTripId: 'fail', ok: false, at: T });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n.detach();

    const dry = stubHost(state({ dryRun: true }));
    const n2 = attachSummaryNotifier(dry.host, { port, appState: background });
    drive(dry, 'sim', ok('sim'));
    await n2.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n2.detach();
  });

  test('an unscored drive (a passenger, or who-was-driving) still gets one: it is ready to look at', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 'p', ok('p', { status: 'unscored' }));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('not while the app is in the foreground on the end screen — the screen itself is the answer', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const appState = { currentState: 'active' as string | null };
    const n = attachSummaryNotifier(h.host, { port, appState });
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
    const n = attachSummaryNotifier(h.host, { port, appState: { currentState: 'active' } });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('a new candidate cancels the pending notification; so does recording', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    h.push({ status: 'candidate', clientTripId: 't2' });
    await n.settled();
    expect(port.pending()).toHaveLength(0);
    n.detach();

    const r = stubHost(state());
    const port2 = fakePort();
    const n2 = attachSummaryNotifier(r.host, { port: port2, appState: background });
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
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    // The next drive starts inside the 120 s: the first request is cancelled, not forgotten.
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending()).toEqual([
      {
        identifier: 'drive-summary:t2',
        title: '2 drives are ready',
        body: 'Tap to see how they went',
        clientTripIds: ['t1', 't2'],
        seconds: 120,
      },
    ]);
    n.detach();
  });

  test('a false start (a candidate that is discarded) gives the cancelled notification back, 120 s on', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    h.push({ status: 'candidate', clientTripId: 'walk' });
    await n.settled();
    expect(port.pending()).toHaveLength(0);
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t1'], seconds: 120 })]);
    n.detach();
  });

  test('a short drive after a pending one: the pending one comes back alone', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    drive(h, 'hop', ok('hop', { short: true }));
    await n.settled();
    expect(port.pending()).toEqual([
      expect.objectContaining({ clientTripIds: ['t1'], title: 'Your drive is ready' }),
    ]);
    n.detach();
  });

  test('a finalize that lands while the next candidate is already open waits for that drive to end', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
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
    // Attached after the previous drive finalized (a fresh store, a hook re-mount): the carried
    // value is not this notifier's news.
    const h = stubHost(state({ lastFinalized: ok('old') }));
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    h.push({ speedMps: 1 });
    h.push({ status: 'candidate', clientTripId: 'false-start' });
    h.push({ status: 'armed', clientTripId: null }); // discarded candidate: lastFinalized unchanged
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();

    // And an outcome for a trip this notifier never watched is not announced either — not now,
    // and not at the next return to idle.
    h.push({ lastFinalized: ok('someone-else') });
    h.push({ status: 'candidate', clientTripId: 'another-false-start' });
    h.push({ status: 'armed', clientTripId: null });
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();

    // Even while a different trip is being recorded.
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
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    h.push({ status: 'finalizing' });
    h.push({ status: 'armed', clientTripId: null, lastFinalized: ok('adopted') });
    await n.settled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('two attaches to one host share one notifier (the hook and the headless runtime)', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const a = attachSummaryNotifier(h.host, { port, appState: background });
    const b = attachSummaryNotifier(h.host, { port, appState: background });
    expect(h.listeners()).toBe(1);
    drive(h, 't1', ok('t1'));
    await a.settled();
    expect(port.schedule).toHaveBeenCalledTimes(1);
    a.detach();
    expect(h.listeners()).toBe(1);
    b.detach();
    expect(h.listeners()).toBe(0);
  });

  test('the 1 Hz path costs nothing: rows while recording make no port call', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    h.push({ status: 'recording', clientTripId: 't1' });
    await n.settled();
    (port.scheduled as jest.Mock).mockClear();
    (port.cancel as jest.Mock).mockClear();
    for (let i = 0; i < 60; i++) h.push({ speedMps: i, lastRowTs: T + i * 1000 });
    await n.settled();
    expect(port.scheduled).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
    n.detach();
  });

  test('m3: the cap switch flipped with no counter wired fails closed, and says so once', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const onError = jest.fn();
    const n = attachSummaryNotifier(h.host, {
      port,
      appState: background,
      countsTowardDailyCap: () => true,
      onError,
    });
    drive(h, 't1', ok('t1'));
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'summary.cap');
    n.detach();
  });

  test('m3: the cap switch flipped asks the counter — no means none, yes means one', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const dailyCapAllows = jest.fn(async () => false);
    const n = attachSummaryNotifier(h.host, {
      port,
      appState: background,
      countsTowardDailyCap: () => true,
      dailyCapAllows,
    });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(dailyCapAllows).toHaveBeenCalledTimes(1);
    expect(port.schedule).not.toHaveBeenCalled();
    dailyCapAllows.mockResolvedValue(true);
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t2'] })]);
    n.detach();
  });

  test('m3 negative control: switch off, the counter is never consulted', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const dailyCapAllows = jest.fn(async () => false);
    const n = attachSummaryNotifier(h.host, { port, appState: background, dailyCapAllows });
    drive(h, 't1', ok('t1'));
    await n.settled();
    expect(dailyCapAllows).not.toHaveBeenCalled();
    expect(port.pending()).toHaveLength(1);
    n.detach();
  });

  test('m2: a deleted drive leaves its pending notification; the rest of a batch is announced without it', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    drive(h, 't2', ok('t2'));
    await n.settled();
    expect(port.pending()[0]?.clientTripIds).toEqual(['t1', 't2']);
    await cancelDriveSummaries('t1');
    expect(port.pending()).toEqual([
      expect.objectContaining({ clientTripIds: ['t2'], title: 'Your drive is ready' }),
    ]);
    await cancelDriveSummaries('t2');
    expect(port.pending()).toEqual([]);
    n.detach();
  });

  test('m2: a drive deleted while carried (cancelled by the next drive) is never announced', async () => {
    const h = stubHost(state());
    const port = fakePort();
    const n = attachSummaryNotifier(h.host, { port, appState: background });
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
    const n = attachSummaryNotifier(h.host, { port, appState: background });
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
    const n = attachSummaryNotifier(h.host, { port, appState: background });
    drive(h, 't1', ok('t1'));
    await n.settled();
    await cancelDriveSummaries('other');
    expect(port.pending()).toEqual([expect.objectContaining({ clientTripIds: ['t1'] })]);
    n.detach();
  });

  test('m2: with no notifier attached, the OS requests naming the drive are cancelled directly', async () => {
    const port = fakePort();
    await port.schedule({ identifier: 'drive-summary:a', title: 't', body: 'b', clientTripIds: ['a'], seconds: 120 });
    await port.schedule({ identifier: 'drive-summary:b', title: 't', body: 'b', clientTripIds: ['b'], seconds: 120 });
    await cancelDriveSummaries('a', port);
    expect(port.pending().map((p) => p.identifier)).toEqual(['drive-summary:b']);
    await cancelDriveSummaries(undefined, port);
    expect(port.pending()).toEqual([]);
  });

  test('the daily-cap question is one named switch, off until the product answer lands', () => {
    expect(DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP).toBe(false);
    expect(summaryCountsTowardDailyCap()).toBe(false);
  });
});

describe('summaryContent', () => {
  test('one drive, and a batch', () => {
    expect(summaryContent(['a'])).toEqual({ title: 'Your drive is ready', body: 'Tap to see how it went' });
    expect(summaryContent(['a', 'b'])).toEqual({ title: '2 drives are ready', body: 'Tap to see how they went' });
  });
});

describe('createExpoSummaryPort', () => {
  test('schedules with an OS time trigger of 120 s on the drive-summary channel, tagged for routing', async () => {
    const port = createExpoSummaryPort('android');
    await port.schedule({
      identifier: 'drive-summary:t1',
      title: 'Your drive is ready',
      body: 'Tap to see how it went',
      clientTripIds: ['t1'],
      seconds: 120,
    });
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('drive-summary', {
      name: 'Drive summaries',
      importance: 3,
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'drive-summary:t1',
      content: {
        title: 'Your drive is ready',
        body: 'Tap to see how it went',
        data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: ['t1'] },
      },
      trigger: { type: 'timeInterval', seconds: 120, channelId: 'drive-summary' },
    });
  });

  test('iOS has no channel to create', async () => {
    const port = createExpoSummaryPort('ios');
    await port.schedule({ identifier: 'x', title: 't', body: 'b', clientTripIds: ['x'], seconds: 120 });
    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  test('reads only its own pending requests', async () => {
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValueOnce([
      { identifier: 'drive-summary:a', content: { data: { kind: DRIVE_SUMMARY_KIND, clientTripIds: ['a'] } } },
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

describe('summaryHrefFor', () => {
  const response = (data: unknown, action = 'expo.modules.notifications.actions.DEFAULT') =>
    ({
      actionIdentifier: action,
      notification: { date: T, request: { identifier: 'drive-summary:a', content: { data } } },
    }) as unknown as Notifications.NotificationResponse;

  test('one drive → its summary; a batch → the trips list; anything else → nothing', () => {
    expect(summaryHrefFor(response({ kind: DRIVE_SUMMARY_KIND, clientTripIds: ['a'] }))).toEqual(tripSummaryHref('a'));
    expect(summaryHrefFor(response({ kind: DRIVE_SUMMARY_KIND, clientTripIds: ['a', 'b'] }))).toEqual(TRIP_HISTORY_HREF);
    expect(summaryHrefFor(response({ kind: 'weekly' }))).toBeNull();
    expect(summaryHrefFor(response(null))).toBeNull();
    expect(summaryHrefFor(response({ kind: DRIVE_SUMMARY_KIND, clientTripIds: [] }))).toBeNull();
  });
});
