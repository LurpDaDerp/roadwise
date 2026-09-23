import { act, renderHook, waitFor } from '@testing-library/react-native';

import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import {
  clearInboxClients,
  fakeAppState,
  setOnline,
  settleInbox,
  testQueryClient,
} from '@/features/inbox/__fixtures__/harness';

import { RewardsRpcError, type RewardsApi, type RewardsSnapshot } from '../api';
import { resetEnsureWeekForTests, useEnsureWeek } from '../useEnsureWeek';
import { goalRow, NOW, snapshot, UID } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession: { session: { user: { id: string } } | null } = { session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
// The device's week is decided in a fixed zone here: NOW is Wednesday 2026-09-23, week of 09-21.
jest.mock('@/lib/deviceZone', () => ({ deviceZone: () => 'UTC' }));

let clock = NOW;
beforeEach(() => {
  clock = NOW;
  resetEnsureWeekForTests();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockSession.session = { user: { id: UID } };
  jest.restoreAllMocks();
});

function api(snap: RewardsSnapshot, open: () => Promise<unknown> = async () => ({})) {
  const server = { snapshot: snap };
  const a: RewardsApi = {
    fetchSnapshot: jest.fn(async () => server.snapshot),
    fetchRewardDay: jest.fn(async () => null),
    openMyWeek: jest.fn(async () => {
      await open();
      server.snapshot = { ...server.snapshot, currentGoal: goalRow('2026-09-21') };
      return { week_start: '2026-09-21', category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false } as const;
    }),
    setWeeklyFocus: jest.fn(),
    joinChallenge: jest.fn(),
    leaveChallenge: jest.fn(),
  };
  return { api: a, server };
}

async function mount(a: RewardsApi, db?: Awaited<ReturnType<typeof createTestDb>>) {
  const client = testQueryClient();
  const wrapper = wrapperFor(db ?? (await createTestDb()), client, () => clock);
  const hook = await renderHook(() => useEnsureWeek({ api: a, appState: fakeAppState() }), { wrapper });
  return { hook, client, wrapper };
}

const opens = (a: RewardsApi) => (a.openMyWeek as jest.Mock).mock.calls.length;
const fetches = (a: RewardsApi) => (a.fetchSnapshot as jest.Mock).mock.calls.length;

test("no goal yet: open_my_week once, then the rewards are refetched", async () => {
  const { api: a } = api(snapshot({ currentGoal: null, lastGoal: null }));
  const { hook } = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(1));
  await waitFor(() => expect(fetches(a)).toBe(2));
  await settleInbox();
  expect(opens(a)).toBe(1);
  await hook.unmount();
});

test("the newest goal is last week's: opened", async () => {
  const { api: a } = api(snapshot({ currentGoal: goalRow('2026-09-14') }));
  const { hook } = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(1));
  await hook.unmount();
});

test("this week's goal already exists: never called", async () => {
  const { api: a } = api(snapshot({ currentGoal: goalRow('2026-09-21') }));
  const { hook } = await mount(a);
  await waitFor(() => expect(fetches(a)).toBe(1));
  await settleInbox();
  expect(opens(a)).toBe(0);
  await hook.unmount();
});

test('once per app session per week: a remount, and a second screen, do not call it again', async () => {
  const { api: a, server } = api(snapshot({ currentGoal: null }));
  // The server keeps answering "no goal" (say it refused quietly): the guard still holds.
  a.openMyWeek = jest.fn(async () => {
    server.snapshot = { ...server.snapshot };
    return { week_start: '2026-09-21', category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false } as const;
  });
  const first = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(1));
  await first.hook.unmount();
  const second = await mount(a);
  await settleInbox();
  expect(opens(a)).toBe(1);
  await second.hook.unmount();

  // A new week, same session: once more.
  clock = Date.parse('2026-09-29T12:00:00Z');
  const third = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(2));
  await third.hook.unmount();
});

test('never while offline (and not from the offline cache)', async () => {
  setOnline(false);
  const { api: a } = api(snapshot({ currentGoal: null }));
  const db = await createTestDb();
  const { writeCachedRewards } = jest.requireActual<typeof import('../cache')>('../cache');
  const { createSettingsRepo } = jest.requireActual<typeof import('@/data/db/settings')>('@/data/db/settings');
  await writeCachedRewards(createSettingsRepo(db), UID, snapshot({ currentGoal: null }));
  const { hook } = await mount(a, db);
  await settleInbox();
  expect(opens(a)).toBe(0);
  await hook.unmount();
});

test('a call that could not reach the server is not spent: it goes again when a later answer arrives online', async () => {
  let fail = true;
  const { api: a } = api(snapshot({ currentGoal: null }), async () => {
    if (fail) throw new RewardsRpcError('offline');
  });
  const w = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(1));
  fail = false;
  clock += 60_000; // a later answer
  await act(async () => {
    await w.client.invalidateQueries({ queryKey: ['rewards'] });
  });
  await waitFor(() => expect(opens(a)).toBe(2));
  await w.hook.unmount();
});

test('a refusal (an ineligible account) is spent: no retry this session', async () => {
  const { api: a } = api(snapshot({ currentGoal: null }), async () => {
    throw new RewardsRpcError('not_available');
  });
  const w = await mount(a);
  await waitFor(() => expect(opens(a)).toBe(1));
  clock += 60_000;
  await act(async () => {
    await w.client.invalidateQueries({ queryKey: ['rewards'] });
  });
  await settleInbox();
  expect(opens(a)).toBe(1);
  await w.hook.unmount();
});
