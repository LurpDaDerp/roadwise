import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { resetDriveScreenPresence, setDriveScreenFocused } from '@/features/drive/hudPresence';
import {
  attachSummaryNotifier,
  cancelDriveSummaries,
  RECAP_MAX_AGE_MS,
  summaryCopy,
  summaryHref,
  type SummaryNotificationPort,
  type SummaryNotifierDeps,
  type SummaryRequest,
} from '@/features/drive/summaryNotifier';

jest.mock('expo-notifications', () => ({}));

/** "Now" for every notifier here: the drives below ended moments before it. */
const NOW = 1_000_000;

afterEach(() => resetDriveScreenPresence());

function hostStub(initial: Partial<DriveState>) {
  let s = { status: 'idle', clientTripId: null, lastFinalized: null, ...initial } as DriveState;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => s,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Pick<DriveHost, 'subscribe' | 'snapshot'>;
  const set = (over: Partial<DriveState>) => {
    s = { ...s, ...over };
    for (const fn of listeners) fn(s);
  };
  return { host, set, listeners };
}

function port(granted = true) {
  const scheduled: SummaryRequest[] = [];
  const cancelled: string[] = [];
  const p: SummaryNotificationPort = {
    permissionGranted: async () => granted,
    schedule: async (r) => void scheduled.push(r),
    scheduled: async () => scheduled.map((r) => r.identifier),
    cancel: async (id) => void cancelled.push(id),
  };
  return { p, scheduled, cancelled };
}

const attach = (host: Pick<DriveHost, 'subscribe' | 'snapshot'>, deps: SummaryNotifierDeps) => attachSummaryNotifier(host, { now: () => NOW, ...deps });

const kept = (
  clientTripId: string,
  at: number,
  o: { durationS?: number | null; miles?: number | null; endCause?: 'stopped' | 'manual'; endedAt?: number | null } = {}
): LastFinalized => ({
  clientTripId,
  ok: true,
  status: 'pending',
  dropped: null,
  endCause: o.endCause ?? 'stopped',
  at,
  durationS: o.durationS === undefined ? 1440 : o.durationS,
  miles: o.miles === undefined ? 12 : o.miles,
  ...(o.endedAt === undefined ? {} : { endedAt: o.endedAt }),
});

const cancelledOf = (clientTripId: string): LastFinalized => ({ clientTripId, ok: true, status: null, dropped: 'cancelled', endCause: 'manual', at: NOW, durationS: null, miles: null });

test('a kept drive that ends while the app is not in front posts "Your drive recap is ready" with its time and distance, opening the fresh recap', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  set({ status: 'idle', lastFinalized: kept('abc', 5) });
  await n.settled();
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]).toEqual({
    identifier: 'drive-summary:abc',
    clientTripId: 'abc',
    title: 'Your drive recap is ready',
    body: '24 min · 12.0 mi. See how it went.',
    url: '/drives/abc?fresh=1',
  });
  expect(summaryHref('abc')).toBe('/drives/abc?fresh=1');
  // The same outcome re-published is not announced twice; a later drive is.
  set({ status: 'idle' });
  set({ lastFinalized: kept('def', 9) });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['abc', 'def']);
  n.detach();
});

test('an automatic drive’s recap carries the category its "I wasn’t driving" action belongs to; a category that cannot be read leaves it off', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const category = jest.fn(async (id: string) => {
    if (id === 'bad') throw new Error('db');
    return id === 'auto' ? 'autoDriveRecap' : null;
  });
  const n = attach(host, { port: p, appState: { currentState: 'background' }, category });
  for (const [id, at] of [['auto', 5], ['manual', 6], ['bad', 7]] as const) {
    set({ status: 'idle', lastFinalized: kept(id, at) });
    await n.settled();
  }
  expect(scheduled.map((r) => [r.clientTripId, r.categoryIdentifier])).toEqual([
    ['auto', 'autoDriveRecap'],
    ['manual', undefined],
    ['bad', undefined],
  ]);
  n.detach();
});

test('kilometres when the driver uses them; without numbers, the last sentence alone; no points', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' }, units: async () => 'km' });
  set({ lastFinalized: kept('abc', 5, { durationS: 3900, miles: 10 }) });
  await n.settled();
  expect(scheduled[0]!.body).toBe('1 h 05 min · 16.1 km. See how it went.');
  expect(summaryCopy.body(null, 3, 'mi')).toBe('See how it went.');
  for (const r of scheduled) expect(`${r.title} ${r.body}`).not.toMatch(/points?|pts/i);
  n.detach();
});

test('units that cannot be read fall back to miles', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attach(host, {
    port: p,
    appState: { currentState: 'background' },
    units: async () => {
      throw new Error('db closed');
    },
  });
  set({ lastFinalized: kept('abc', 5) });
  await n.settled();
  expect(scheduled[0]!.body).toBe('24 min · 12.0 mi. See how it went.');
  n.detach();
});

test('each drive posts its recap once and it stays up: the next drive opening and ending (however soon) posts its own, nothing comes down', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled, cancelled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  set({ lastFinalized: kept('abc', 5, { durationS: 600, miles: 4 }) });
  await n.settled();
  set({ status: 'recording', clientTripId: 'def' });
  await n.settled();
  set({ status: 'idle', clientTripId: null, lastFinalized: kept('def', 900, { durationS: 1500, miles: 9 }) });
  await n.settled();
  // The same end seen again posts nothing more.
  set({ status: 'idle' });
  await n.settled();
  expect(scheduled.map((r) => [r.identifier, r.body])).toEqual([
    ['drive-summary:abc', '10 min · 4.0 mi. See how it went.'],
    ['drive-summary:def', '25 min · 9.0 mi. See how it went.'],
  ]);
  expect(cancelled).toEqual([]);
  n.detach();
});

test('in front, it posts unless the driving screen shows the end (it opens the recap itself): by default the driving screen’s focus decides', async () => {
  // Told the end flow shows: nothing.
  const a = hostStub({});
  const pa = port();
  const na = attach(a.host, { port: pa.p, appState: { currentState: 'active' }, isSummaryVisible: () => true });
  a.set({ lastFinalized: kept('abc', 5) });
  await na.settled();
  expect(pa.scheduled).toEqual([]);
  na.detach();

  // Told it does not (Home, Analytics, a recap of another drive): it posts.
  const b = hostStub({});
  const pb = port();
  const nb = attach(b.host, { port: pb.p, appState: { currentState: 'active' }, isSummaryVisible: () => false });
  b.set({ lastFinalized: kept('abc', 5) });
  await nb.settled();
  expect(pb.scheduled.map((r) => r.clientTripId)).toEqual(['abc']);
  nb.detach();

  // The default: the driving screen focused with RoadWise in front holds it; on another screen it posts.
  const c = hostStub({});
  const pc = port();
  const appState = { currentState: 'active' as string | null };
  const nc = attach(c.host, { port: pc.p, appState });
  setDriveScreenFocused(true, 'abc');
  c.set({ lastFinalized: kept('abc', 5) });
  await nc.settled();
  expect(pc.scheduled).toEqual([]);
  setDriveScreenFocused(false, 'abc');
  c.set({ lastFinalized: kept('def', 6) });
  await nc.settled();
  expect(pc.scheduled.map((r) => r.clientTripId)).toEqual(['def']);
  // Behind, the screen's last focus never holds it.
  setDriveScreenFocused(true, 'ghi');
  appState.currentState = 'background';
  c.set({ lastFinalized: kept('ghi', 7) });
  await nc.settled();
  expect(pc.scheduled.map((r) => r.clientTripId)).toEqual(['def', 'ghi']);
  nc.detach();
});

test('the driving screen in front when the drive ends decides, even once it has moved on to the recap before the chain runs', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  let focused = true;
  const n = attach(host, { port: p, appState: { currentState: 'active' }, isSummaryVisible: () => focused });
  // Something before it on the chain (a cancel) keeps the chain busy.
  set({ lastFinalized: cancelledOf('earlier') });
  set({ lastFinalized: kept('abc', 5) });
  // The driving screen leaves for the recap right away.
  focused = false;
  await n.settled();
  expect(scheduled).toEqual([]);
  n.detach();
});

test('nothing without permission, or for a failed save', async () => {
  const denied = port(false);
  const b = hostStub({});
  const n2 = attach(b.host, { port: denied.p, appState: { currentState: 'background' } });
  b.set({ lastFinalized: kept('abc', 5) });
  b.set({ lastFinalized: { clientTripId: 'ghi', ok: false, at: 6 } });
  await n2.settled();
  expect(denied.scheduled).toEqual([]);
  n2.detach();

  const ok = port();
  const c = hostStub({});
  const n3 = attach(c.host, { port: ok.p, appState: { currentState: 'background' } });
  c.set({ lastFinalized: { clientTripId: 'ghi', ok: false, at: 6 } });
  c.set({ lastFinalized: { ...(kept('jkl', 7) as object), status: 'failed' } as LastFinalized });
  await n3.settled();
  expect(ok.scheduled).toEqual([]);
  n3.detach();
});

test('a drive that was not kept, or was discarded with "Not driving?", posts nothing, in the background too; a kept one after it still does', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  set({ status: 'idle', lastFinalized: { clientTripId: 'gone', ok: true, status: null, dropped: 'no_movement', endCause: 'stopped', at: 5, durationS: null, miles: null } });
  set({ status: 'idle', lastFinalized: cancelledOf('passenger') });
  await n.settled();
  expect(scheduled).toEqual([]);
  set({ lastFinalized: kept('kept', 9, { endCause: 'manual' }) });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['kept']);
  n.detach();
});

test('a drive that ended more than 2 h ago (stored at a later launch) posts nothing; one that ended within 2 h does, its end time deciding', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  expect(RECAP_MAX_AGE_MS).toBe(2 * 60 * 60_000);
  // Finalized now, but ended 2 h and 1 ms ago: too old.
  set({ lastFinalized: kept('old', NOW, { endedAt: NOW - RECAP_MAX_AGE_MS - 1 }) });
  // Ended exactly 2 h ago: still posts.
  set({ lastFinalized: kept('edge', NOW + 1, { endedAt: NOW - RECAP_MAX_AGE_MS }) });
  // Without an end time, the finalize time stands in.
  set({ lastFinalized: kept('noEnd', NOW - RECAP_MAX_AGE_MS - 5) });
  set({ lastFinalized: kept('fresh', NOW + 2, { endedAt: NOW - 60_000 }) });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['edge', 'fresh']);
  n.detach();
});

test('attached before the host boots: a drive the boot stores posts; one due while the next drive records waits until no drive records, then posts by the same rules', async () => {
  // A host not booted yet: idle, nothing finalized.
  const { host, set } = hostStub({});
  const { p, scheduled, cancelled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  // The boot takes an ended journal in (quiet), ends it, stores it ...
  set({ status: 'recording', clientTripId: 'ended' });
  set({ status: 'finalizing' });
  set({ status: 'idle', clientTripId: null, lastFinalized: kept('ended', NOW, { endedAt: NOW - 30 * 60_000 }) });
  // ... then begins the drive native records now, before the recap's chain got to the OS.
  set({ status: 'recording', clientTripId: 'live' });
  await n.settled();
  expect(scheduled).toEqual([]);
  // A change while it records posts nothing either.
  set({ status: 'recording', clientTripId: 'live' });
  await n.settled();
  expect(scheduled).toEqual([]);
  // The live drive ends: both recaps post, the held one too; nothing was taken down.
  set({ status: 'idle', clientTripId: null, lastFinalized: kept('live', NOW + 10) });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId).sort()).toEqual(['ended', 'live']);
  expect(cancelled).toEqual([]);
  n.detach();
});

test('an end published while its drive is still finishing waits for the idle state, then posts once', async () => {
  const { host, set } = hostStub({ status: 'recording', clientTripId: 'abc' });
  const { p, scheduled } = port();
  const n = attach(host, { port: p, appState: { currentState: 'background' } });
  set({ status: 'finalizing', lastFinalized: kept('abc', 5) });
  await n.settled();
  expect(scheduled).toEqual([]);
  set({ status: 'idle', clientTripId: null });
  await n.settled();
  set({ status: 'idle' });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['abc']);
  n.detach();
});

test('a held recap is not posted after the notifier is detached', async () => {
  const b = hostStub({});
  const pb = port();
  const nb = attach(b.host, { port: pb.p, appState: { currentState: 'background' } });
  b.set({ lastFinalized: kept('def', 5) });
  b.set({ status: 'recording', clientTripId: 'other' });
  await nb.settled();
  nb.detach();
  b.set({ status: 'idle', clientTripId: null });
  await nb.settled();
  expect(pb.scheduled).toEqual([]);
});

test('cancelDriveSummaries removes every scheduled summary (the handover wipe)', async () => {
  const { p, scheduled, cancelled } = port();
  scheduled.push({ identifier: 'drive-summary:a', clientTripId: 'a', title: '', body: '', url: '' });
  await cancelDriveSummaries(p);
  expect(cancelled).toEqual(['drive-summary:a']);
});

test('a recap held while a later drive recorded still posts when that drive ends on the driving screen (it shows the later drive, not this one)', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const appState = { currentState: 'background' as string | null };
  let focused = false;
  const n = attach(host, { port: p, appState, isSummaryVisible: () => focused });
  // The boot stores X, and takes in Y (recording now) before X's recap reaches the OS: X is held.
  set({ status: 'idle', lastFinalized: kept('X', NOW, { endedAt: NOW - 20 * 60_000 }) });
  set({ status: 'recording', clientTripId: 'Y' });
  await n.settled();
  expect(scheduled).toEqual([]);
  // The driver opened the driving screen from the Live Activity and swipes End there.
  appState.currentState = 'active';
  focused = true;
  set({ status: 'idle', clientTripId: null, lastFinalized: kept('Y', NOW + 5) });
  await n.settled();
  // Y's recap the driving screen opens itself; X's posts.
  expect(scheduled.map((r) => r.identifier)).toEqual(['drive-summary:X']);
  n.detach();
});

test('a held recap older than 2 h by the time no drive records posts nothing', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  let clock = NOW;
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' }, now: () => clock });
  set({ status: 'idle', lastFinalized: kept('X', NOW, { endedAt: NOW - 90 * 60_000 }) });
  set({ status: 'recording', clientTripId: 'Y' });
  await n.settled();
  clock = NOW + 31 * 60_000;
  set({ status: 'idle', clientTripId: null });
  await n.settled();
  expect(scheduled).toEqual([]);
  n.detach();
});

describe('announceStored (an orphan the launch\u2019s crash recovery stored)', () => {
  const orphan = (id: string, endedAt: number, o: Partial<{ status: 'pending' | 'failed'; dropped: 'no_movement' | null }> = {}) =>
    ({ ...(kept(id, NOW, { endedAt }) as object), endCause: 'orphan', ...o }) as Extract<NonNullable<LastFinalized>, { ok: true }>;

  test('a recent kept orphan posts its recap; one older than 2 h, a failed save or a dropped one does not', async () => {
    const { host } = hostStub({});
    const { p, scheduled } = port();
    const n = attach(host, { port: p, appState: { currentState: 'background' } });
    n.announceStored([
      orphan('recent', NOW - 10 * 60_000),
      orphan('old', NOW - RECAP_MAX_AGE_MS - 1),
      orphan('failed', NOW - 60_000, { status: 'failed' }),
      orphan('dropped', NOW - 60_000, { dropped: 'no_movement' }),
    ]);
    await n.settled();
    expect(scheduled.map((r) => [r.identifier, r.body])).toEqual([['drive-summary:recent', '24 min · 12.0 mi. See how it went.']]);
    n.detach();
  });

  test('none with the driving screen in front', async () => {
    const { host } = hostStub({});
    const { p, scheduled } = port();
    const n = attach(host, { port: p, appState: { currentState: 'active' }, isSummaryVisible: () => true });
    n.announceStored([orphan('recent', NOW - 60_000)]);
    await n.settled();
    expect(scheduled).toEqual([]);
    n.detach();
  });

  test('held while a drive records, posted once none does', async () => {
    const { host, set } = hostStub({ status: 'recording', clientTripId: 'live' });
    const { p, scheduled } = port();
    const n = attach(host, { port: p, appState: { currentState: 'background' } });
    n.announceStored([orphan('recent', NOW - 60_000)]);
    await n.settled();
    expect(scheduled).toEqual([]);
    set({ status: 'idle', clientTripId: null });
    await n.settled();
    expect(scheduled.map((r) => r.clientTripId)).toEqual(['recent']);
    n.detach();
  });

  test('nothing once detached', async () => {
    const { host } = hostStub({});
    const { p, scheduled } = port();
    const n = attach(host, { port: p, appState: { currentState: 'background' } });
    n.detach();
    n.announceStored([orphan('recent', NOW - 60_000)]);
    await n.settled();
    expect(scheduled).toEqual([]);
  });
});