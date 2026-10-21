import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { attachSummaryNotifier, cancelDriveSummaries, summaryCopy, summaryHref, type SummaryNotificationPort, type SummaryRequest } from '@/features/drive/summaryNotifier';

jest.mock('expo-notifications', () => ({}));

function hostStub(initial: Partial<DriveState>) {
  let s = { status: 'idle', lastFinalized: null, ...initial } as DriveState;
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

const kept = (clientTripId: string, at: number, o: { durationS?: number | null; miles?: number | null; endCause?: 'stopped' | 'manual' } = {}): LastFinalized => ({
  clientTripId,
  ok: true,
  status: 'pending',
  dropped: null,
  endCause: o.endCause ?? 'stopped',
  at,
  durationS: o.durationS === undefined ? 1440 : o.durationS,
  miles: o.miles === undefined ? 12 : o.miles,
});

test('a kept drive that ends while the app is not in front posts "Your drive recap is ready" with its time and distance, opening the fresh recap', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' } });
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

test('kilometres when the driver uses them; without numbers, the last sentence alone; no points', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' }, units: async () => 'km' });
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
  const n = attachSummaryNotifier(host, {
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

test('a drive set off again within 5 minutes re-posts under the same identifier with the longer drive', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' } });
  set({ lastFinalized: kept('abc', 5, { durationS: 600, miles: 4 }) });
  // the continuation re-opens the same trip and ends later
  set({ status: 'recording' });
  set({ status: 'idle', lastFinalized: kept('abc', 900, { durationS: 1500, miles: 9 }) });
  await n.settled();
  expect(scheduled.map((r) => [r.identifier, r.body])).toEqual([
    ['drive-summary:abc', '10 min · 4.0 mi. See how it went.'],
    ['drive-summary:abc', '25 min · 9.0 mi. See how it went.'],
  ]);
  n.detach();
});

test('nothing while the app shows the end flow, without permission, or for a failed save', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'active' } });
  set({ lastFinalized: kept('abc', 5) });
  await n.settled();
  expect(scheduled).toEqual([]);
  n.detach();

  const denied = port(false);
  const b = hostStub({});
  const n2 = attachSummaryNotifier(b.host, { port: denied.p, appState: { currentState: 'background' } });
  b.set({ lastFinalized: kept('abc', 5) });
  b.set({ lastFinalized: { clientTripId: 'ghi', ok: false, at: 6 } });
  await n2.settled();
  expect(denied.scheduled).toEqual([]);
  n2.detach();
});

test('a drive that was not kept, or was discarded with "Not driving?", posts nothing, in the background too; a kept one after it still does', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' } });
  set({ status: 'idle', lastFinalized: { clientTripId: 'gone', ok: true, status: null, dropped: 'no_movement', endCause: 'stopped', at: 5, durationS: null, miles: null } });
  set({ status: 'idle', lastFinalized: { clientTripId: 'passenger', ok: true, status: null, dropped: 'cancelled', endCause: 'manual', at: 6, durationS: null, miles: null } });
  await n.settled();
  expect(scheduled).toEqual([]);
  set({ lastFinalized: kept('kept', 9, { endCause: 'manual' }) });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['kept']);
  n.detach();
});

test('cancelDriveSummaries removes every scheduled summary (the handover wipe)', async () => {
  const { p, scheduled, cancelled } = port();
  scheduled.push({ identifier: 'drive-summary:a', clientTripId: 'a', title: '', body: '', url: '' });
  await cancelDriveSummaries(p);
  expect(cancelled).toEqual(['drive-summary:a']);
});
