import type { DriveHost, DriveState } from '@/drive/host';
import { attachSummaryNotifier, cancelDriveSummaries, summaryHref, type SummaryNotificationPort, type SummaryRequest } from '@/features/drive/summaryNotifier';

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

test('a drive finalized while the app is not in front schedules "Drive ended — see your points" opening the fresh summary', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'background' } });
  set({ status: 'idle', lastFinalized: { clientTripId: 'abc', ok: true, status: 'pending', pointsNet: 120, at: 5 } });
  await n.settled();
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]).toMatchObject({ clientTripId: 'abc', title: 'Drive ended', body: 'See your points', url: '/drives/abc?fresh=1' });
  expect(summaryHref('abc')).toBe('/drives/abc?fresh=1');
  // The same outcome re-published is not announced twice; a later drive is.
  set({ status: 'idle' });
  set({ lastFinalized: { clientTripId: 'def', ok: true, status: 'pending', pointsNet: null, at: 9 } });
  await n.settled();
  expect(scheduled.map((r) => r.clientTripId)).toEqual(['abc', 'def']);
  n.detach();
});

test('nothing while the app shows the end flow, without permission, or for a failed save', async () => {
  const { host, set } = hostStub({});
  const { p, scheduled } = port();
  const n = attachSummaryNotifier(host, { port: p, appState: { currentState: 'active' } });
  set({ lastFinalized: { clientTripId: 'abc', ok: true, status: 'pending', pointsNet: 1, at: 5 } });
  await n.settled();
  expect(scheduled).toEqual([]);
  n.detach();

  const denied = port(false);
  const b = hostStub({});
  const n2 = attachSummaryNotifier(b.host, { port: denied.p, appState: { currentState: 'background' } });
  b.set({ lastFinalized: { clientTripId: 'abc', ok: true, status: 'pending', pointsNet: 1, at: 5 } });
  b.set({ lastFinalized: { clientTripId: 'ghi', ok: false, at: 6 } });
  await n2.settled();
  expect(denied.scheduled).toEqual([]);
  n2.detach();
});

test('cancelDriveSummaries removes every scheduled summary (the handover wipe)', async () => {
  const { p, scheduled, cancelled } = port();
  scheduled.push({ identifier: 'drive-summary:a', clientTripId: 'a', title: '', body: '', url: '' });
  await cancelDriveSummaries(p);
  expect(cancelled).toEqual(['drive-summary:a']);
});
