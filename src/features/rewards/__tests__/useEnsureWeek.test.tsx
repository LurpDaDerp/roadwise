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
import {
  currentServerWeekStart,
  resetEnsureWeekForTests,
  useCurrentWeekStart,
  useEnsureWeek,
} from '../useEnsureWeek';
import { goalRow, NOW, snapshot, UID } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession: { session: { user: { id: string } } | null } = { session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
// The device's week is decided in a fixed zone here: NOW is Wednesday 2026-09-23, week of 09-21.
let mockZone = 'UTC';
jest.mock('@/lib/deviceZone', () => ({ deviceZone: () => mockZone }));

let clock = NOW;
beforeEach(() => {
  clock = NOW;
  resetEnsureWeekForTests();
  mockZone = 'UTC';
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

describe("the server's week, not the device's (final review m9)", () => {
  /**
   * The phone is in Kiritimati (UTC+14); the account's zone on the server is UTC. At 00:30 on
   * Monday 2026-09-28 on the phone it is still Sunday 10:30 on the server, so `open_my_week`
   * answers with the week of 2026-09-21.
   */
  test('a device zone ahead of the account zone at Monday midnight: asks again, hourly, until the server week arrives', async () => {
    mockZone = 'Pacific/Kiritimati';
    clock = Date.parse('2026-09-27T10:30:00Z');
    const serverWeek = () => (clock >= Date.parse('2026-09-28T00:00:00Z') ? '2026-09-28' : '2026-09-21');
    const server = { snapshot: snapshot({ currentGoal: goalRow('2026-09-21') }) };
    const a: RewardsApi = {
      fetchSnapshot: jest.fn(async () => server.snapshot),
      fetchRewardDay: jest.fn(async () => null),
      openMyWeek: jest.fn(async () => {
        const week = serverWeek();
        server.snapshot = { ...server.snapshot, currentGoal: goalRow(week) };
        return { week_start: week, category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false } as const;
      }),
      setWeeklyFocus: jest.fn(),
      joinChallenge: jest.fn(),
      leaveChallenge: jest.fn(),
    };
    const w = await mount(a);
    await waitFor(() => expect(opens(a)).toBe(1));
    await waitFor(() => expect(fetches(a)).toBe(2)); // the refetch after the answer
    await settleInbox();
    // The server's answer was last week: not taken as "opened", but not asked again at once either.
    expect(opens(a)).toBe(1);

    const answer = async (advanceMs: number) => {
      clock += advanceMs;
      await act(async () => {
        await w.client.invalidateQueries({ queryKey: ['rewards'] });
      });
      await settleInbox();
    };

    await answer(30 * 60_000); // 30 min later, still the server's Sunday
    expect(opens(a)).toBe(1);
    await answer(31 * 60_000); // over an hour since the last answer: ask again (still Sunday there)
    expect(opens(a)).toBe(2);
    await answer(14 * 3_600_000); // 01:31 UTC on Monday: the server's Monday has come
    expect(opens(a)).toBe(3);
    // The server opened this week: settled for the session, however many answers follow.
    await answer(2 * 3_600_000);
    await answer(2 * 3_600_000);
    expect(opens(a)).toBe(3);
    await w.hook.unmount();
  });

  test('negative control: with the zones agreeing, one call opens the week for the session', async () => {
    mockZone = 'UTC';
    clock = Date.parse('2026-09-28T00:30:00Z');
    const server = { snapshot: snapshot({ currentGoal: goalRow('2026-09-21') }) };
    const a: RewardsApi = {
      fetchSnapshot: jest.fn(async () => server.snapshot),
      fetchRewardDay: jest.fn(async () => null),
      // The server says this week, but (say) its goal row has not reached the snapshot yet.
      openMyWeek: jest.fn(async () => ({ week_start: '2026-09-28', category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false }) as const),
      setWeeklyFocus: jest.fn(),
      joinChallenge: jest.fn(),
      leaveChallenge: jest.fn(),
    };
    const w = await mount(a);
    await waitFor(() => expect(opens(a)).toBe(1));
    clock += 2 * 3_600_000;
    await act(async () => {
      await w.client.invalidateQueries({ queryKey: ['rewards'] });
    });
    await settleInbox();
    expect(opens(a)).toBe(1);
    await w.hook.unmount();
  });
});

describe('useCurrentWeekStart: the server\'s week for the screens (final review m9)', () => {
  function weekApi(snap: RewardsSnapshot, serverWeek: () => string) {
    const server = { snapshot: snap };
    const a: RewardsApi = {
      fetchSnapshot: jest.fn(async () => server.snapshot),
      fetchRewardDay: jest.fn(async () => null),
      openMyWeek: jest.fn(async () => {
        const week = serverWeek();
        server.snapshot = { ...server.snapshot, currentGoal: goalRow(week) };
        return { week_start: week, category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false } as const;
      }),
      setWeeklyFocus: jest.fn(),
      joinChallenge: jest.fn(),
      leaveChallenge: jest.fn(),
    };
    return a;
  }

  async function mountBoth(a: RewardsApi) {
    const client = testQueryClient();
    const wrapper = wrapperFor(await createTestDb(), client, () => clock);
    const hook = await renderHook(
      () => {
        useEnsureWeek({ api: a, appState: fakeAppState() });
        return useCurrentWeekStart({ api: a, appState: fakeAppState() });
      },
      { wrapper }
    );
    return { hook, client };
  }

  test('zones agree, this week\'s goal exists: that week, no call', async () => {
    const a = weekApi(snapshot({ currentGoal: goalRow('2026-09-21') }), () => '2026-09-21');
    const { hook } = await mountBoth(a);
    await waitFor(() => expect(hook.result.current).toBe('2026-09-21'));
    expect(opens(a)).toBe(0);
    await hook.unmount();
  });

  test('device ahead at Monday midnight: the server\'s last week until its Monday comes, then the new one', async () => {
    mockZone = 'Pacific/Kiritimati';
    clock = Date.parse('2026-09-27T10:30:00Z');
    const a = weekApi(snapshot({ currentGoal: goalRow('2026-09-21') }), () =>
      clock >= Date.parse('2026-09-28T00:00:00Z') ? '2026-09-28' : '2026-09-21'
    );
    const { hook, client } = await mountBoth(a);
    await waitFor(() => expect(opens(a)).toBe(1));
    await settleInbox();
    // negative control: the device alone would say 2026-09-28
    expect(hook.result.current).toBe('2026-09-21');
    clock = Date.parse('2026-09-28T01:00:00Z');
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['rewards'] });
    });
    await waitFor(() => expect(hook.result.current).toBe('2026-09-28'));
    await hook.unmount();
  });

  test('no answer yet and a goal older than last week: null (fall back to the device week)', async () => {
    setOnline(false);
    const db = await createTestDb();
    const { writeCachedRewards } = jest.requireActual<typeof import('../cache')>('../cache');
    const { createSettingsRepo } = jest.requireActual<typeof import('@/data/db/settings')>('@/data/db/settings');
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot({ currentGoal: goalRow('2026-09-07') }));
    const a = weekApi(snapshot({ currentGoal: goalRow('2026-09-07') }), () => '2026-09-21');
    const client = testQueryClient();
    const hook = await renderHook(() => useCurrentWeekStart({ api: a, appState: fakeAppState() }), {
      wrapper: wrapperFor(db, client, () => clock),
    });
    await waitFor(() => expect(hook.result.current).toBeNull());
    expect(opens(a)).toBe(0);
    await hook.unmount();
  });

  test('device behind the server: the goal the server already made for its week', async () => {
    mockZone = 'Pacific/Pago_Pago'; // UTC-11: still Sunday 2026-09-27 at 2026-09-28 05:00 UTC
    clock = Date.parse('2026-09-28T05:00:00Z');
    const a = weekApi(snapshot({ currentGoal: goalRow('2026-09-28') }), () => '2026-09-28');
    const { hook } = await mountBoth(a);
    await waitFor(() => expect(hook.result.current).toBe('2026-09-28'));
    expect(opens(a)).toBe(0);
    await hook.unmount();
  });
});

describe('currentServerWeekStart (the rule, pure)', () => {
  const snap = (week: string | null) => ({ currentGoal: week === null ? null : goalRow(week) });

  test('zones agree: this week\'s goal is the server\'s week', () => {
    expect(currentServerWeekStart(snap('2026-09-21'), { now: Date.parse('2026-09-23T12:00:00Z'), zone: 'UTC' })).toBe('2026-09-21');
  });

  test('phone AHEAD of the account (Kiritimati, UTC+14) at its Monday 00:30: last week\'s goal is still the server\'s', () => {
    const now = Date.parse('2026-09-27T10:30:00Z'); // Monday 00:30 on the phone, Sunday on a UTC server
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'Pacific/Kiritimati' })).toBe('2026-09-21');
    // 26 h after the phone's Monday began, no zone is in last week any more: a leftover goal is stale
    const later = Date.parse('2026-09-28T12:30:00Z');
    expect(currentServerWeekStart(snap('2026-09-21'), { now: later, zone: 'Pacific/Kiritimati' })).toBeNull();
  });

  test('phone BEHIND the account (Pago Pago, UTC-11) on its Sunday: the server\'s Monday goal is this week\'s', () => {
    const now = Date.parse('2026-09-28T05:00:00Z'); // Sunday 18:00 on the phone
    expect(currentServerWeekStart(snap('2026-09-28'), { now, zone: 'Pacific/Pago_Pago' })).toBe('2026-09-28');
    // negative control: the phone's own week would be 2026-09-21
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'Pacific/Pago_Pago' })).toBe('2026-09-21');
  });

  test('no goal, or one older than last week: null', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(currentServerWeekStart(snap(null), { now, zone: 'UTC' })).toBeNull();
    expect(currentServerWeekStart(snap('2026-09-14'), { now, zone: 'UTC' })).toBeNull();
  });

  test("the session's open_my_week answer wins over the 26 h guess", () => {
    const now = Date.parse('2026-09-28T00:30:00Z'); // zones agree, Monday 00:30, goal not opened yet
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'UTC' })).toBe('2026-09-21');
    expect(
      currentServerWeekStart(snap('2026-09-21'), { now, zone: 'UTC', answered: { week: '2026-09-28', deviceWeek: '2026-09-28' } })
    ).toBe('2026-09-28');
    expect(
      currentServerWeekStart(snap('2026-09-28'), { now, zone: 'UTC', answered: { week: '2026-09-21', deviceWeek: '2026-09-28' } })
    ).toBe('2026-09-28');
  });
});

describe('re-review m-a and m-c: answers and the grace do not outlive their evidence', () => {
  const snap = (week: string | null) => ({ currentGoal: week === null ? null : goalRow(week) });
  const answered = { week: '2026-09-21', deviceWeek: '2026-09-21' };

  test('m-a: an answer is trusted while the device is still in the week it asked in', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'UTC', answered, offline: true })).toBe('2026-09-21');
  });

  test('m-a: kept alive offline into the next week, last week\'s answer is dropped: null, not last week\'s goal', () => {
    const now = Date.parse('2026-09-30T12:00:00Z'); // Wednesday of the next week
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'UTC', answered, offline: true })).toBeNull();
    expect(currentServerWeekStart(snap('2026-09-21'), { now, zone: 'UTC', answered })).toBeNull();
    // control: in the first 26 h of the new week, online, the answer still stands (the spread)
    const monday = Date.parse('2026-09-28T03:00:00Z');
    expect(currentServerWeekStart(snap('2026-09-21'), { now: monday, zone: 'UTC', answered })).toBe('2026-09-21');
    // ...but not from the offline cache
    expect(currentServerWeekStart(snap('2026-09-21'), { now: monday, zone: 'UTC', answered, offline: true })).toBeNull();
  });

  test('m-c: the 26 h grace applies only to a snapshot fetched online', () => {
    const monday = Date.parse('2026-09-28T00:30:00Z'); // zones agree (UTC), Monday 00:30
    expect(currentServerWeekStart(snap('2026-09-21'), { now: monday, zone: 'UTC', offline: false })).toBe('2026-09-21');
    expect(currentServerWeekStart(snap('2026-09-21'), { now: monday, zone: 'UTC', offline: true })).toBeNull();
    // a goal the server already made for the device week is trusted offline too
    expect(currentServerWeekStart(snap('2026-09-28'), { now: monday, zone: 'UTC', offline: true })).toBe('2026-09-28');
  });

  test('m-a, the hook: an app kept alive into the next week, offline, stops claiming last week\'s goal', async () => {
    clock = Date.parse('2026-09-21T09:00:00Z');
    const server = { snapshot: snapshot({ currentGoal: null }) };
    const a: RewardsApi = {
      fetchSnapshot: jest.fn(async () => server.snapshot),
      fetchRewardDay: jest.fn(async () => null),
      openMyWeek: jest.fn(async () => {
        server.snapshot = { ...server.snapshot, currentGoal: goalRow('2026-09-21') };
        return { week_start: '2026-09-21', category: 'phone', source: 'weakest', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false } as const;
      }),
      setWeeklyFocus: jest.fn(),
      joinChallenge: jest.fn(),
      leaveChallenge: jest.fn(),
    };
    const client = testQueryClient();
    const hook = await renderHook(
      () => {
        useEnsureWeek({ api: a, appState: fakeAppState() });
        return useCurrentWeekStart({ api: a, appState: fakeAppState() });
      },
      { wrapper: wrapperFor(await createTestDb(), client, () => clock) }
    );
    await waitFor(() => expect(hook.result.current).toBe('2026-09-21'));
    // The phone goes offline and the process lives on into Wednesday of the next week.
    setOnline(false);
    clock = Date.parse('2026-09-30T12:00:00Z');
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['rewards'] });
    });
    await waitFor(() => expect(hook.result.current).toBeNull());
    await hook.unmount();
  });

  test('m-c, the hook: zones agree, offline cache on Monday 00:30: null (appears when you\'re online)', async () => {
    setOnline(false);
    clock = Date.parse('2026-09-28T00:30:00Z');
    const db = await createTestDb();
    const { writeCachedRewards } = jest.requireActual<typeof import('../cache')>('../cache');
    const { createSettingsRepo } = jest.requireActual<typeof import('@/data/db/settings')>('@/data/db/settings');
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot({ currentGoal: goalRow('2026-09-21') }));
    const hook = await renderHook(() => useCurrentWeekStart({ api: api(snapshot()).api, appState: fakeAppState() }), {
      wrapper: wrapperFor(db, testQueryClient(), () => clock),
    });
    await waitFor(() => expect(hook.result.current).toBeNull());
    await hook.unmount();
  });
});
