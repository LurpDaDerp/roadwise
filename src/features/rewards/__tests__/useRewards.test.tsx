import { act, renderHook, waitFor } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { emitDataChanged } from '@/data/events';
import { QUERY_ROOTS, subscribeInvalidation } from '@/data/queries';
import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import {
  clearInboxClients,
  fakeAppState,
  setOnline,
  settleInbox,
  testQueryClient,
} from '@/features/inbox/__fixtures__/harness';
import { REWARDS_QUERY_KEY } from '@/notifications/keys';

import { RewardsOfflineError, RewardsRpcError, type RewardsApi, type RewardsSnapshot } from '../api';
import { readCachedRewards, writeCachedRewards } from '../cache';
import { rewardDayKey, rewardsKey, REWARDS_STALE_MS } from '../keys';
import {
  useDayAward,
  useJoinChallenge,
  useLeaveChallenge,
  useRewardDay,
  useRewards,
  useSetWeeklyFocus,
} from '../useRewards';
import { NOW, OTHER_UID, progressRow, rewardDayRow, snapshot, UID } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession: { session: { user: { id: string } } | null } = { session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

let clock = NOW;
beforeEach(() => {
  clock = NOW;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockSession.session = { user: { id: UID } };
  jest.restoreAllMocks();
});

/**
 * React Query re-renders only for the result properties read during a render (tracked props); a
 * test that reads them only afterwards would miss an error that landed inside the first act. Read
 * the state properties in the render, as a screen does.
 */
function tracked<T extends { status: unknown; isError: unknown; isSuccess: unknown; error: unknown; data: unknown }>(r: T): T {
  void [r.status, r.isError, r.isSuccess, r.error, r.data];
  return r;
}

function fakeApi(initial: RewardsSnapshot = snapshot()) {
  const server = { snapshot: initial, fail: null as unknown, days: new Map<string, ReturnType<typeof rewardDayRow>>() };
  const api: RewardsApi = {
    fetchSnapshot: jest.fn(async () => {
      if (server.fail) throw server.fail;
      return { ...server.snapshot, fetchedAt: clock };
    }),
    fetchRewardDay: jest.fn(async (day: string) => server.days.get(day) ?? null),
    openMyWeek: jest.fn(async () => {
      throw new Error('not used here');
    }),
    setWeeklyFocus: jest.fn(async (category) => ({
      applied: 'this_week' as const,
      goal: { week_start: '2026-09-21', category, source: 'chosen' as const, target_days: 4, pass_days: 0, fail_days: 0, state: 'active' as const, prorated: false },
    })),
    joinChallenge: jest.fn(async (defId: string) => ({ id: '00000000-0000-4000-8000-000000000123', def_id: defId, start_day: '2026-09-24', state: 'active' as const, pass_days: 0, fail_days: 0 })),
    leaveChallenge: jest.fn(async () => undefined),
  };
  return { api, server };
}

async function mount(opts: { snapshot?: RewardsSnapshot } = {}) {
  const db = await createTestDb();
  const client = testQueryClient();
  const { api, server } = fakeApi(opts.snapshot);
  const appState = fakeAppState();
  const wrapper = wrapperFor(db, client, () => clock);
  const hook = await renderHook(() => useRewards({ api, appState }), { wrapper });
  return { db, client, api, server, appState, hook, wrapper };
}

const fetches = (api: RewardsApi) => (api.fetchSnapshot as jest.Mock).mock.calls.length;

describe('useRewards', () => {
  test('keyed [...REWARDS_QUERY_KEY, uid]; fetches on mount and caches the answer for this uid', async () => {
    expect(rewardsKey(UID)).toEqual([...REWARDS_QUERY_KEY, UID]);
    const { hook, db, client } = await mount();
    await waitFor(() => expect(hook.result.current.data?.offline).toBe(false));
    expect(hook.result.current.data?.snapshot.progress?.points).toBe(1250);
    expect(client.getQueryData(rewardsKey(UID))).toBeDefined();
    expect(await readCachedRewards(createSettingsRepo(db), UID)).toMatchObject({ fetchedAt: NOW });
  });

  test('5-minute stale: a remount inside it does not fetch, one after it does', async () => {
    const { api, hook, wrapper, appState } = await mount();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await hook.unmount();
    clock = NOW + REWARDS_STALE_MS - 1000;
    const again = await renderHook(() => useRewards({ api, appState }), { wrapper });
    await settleInbox();
    expect(fetches(api)).toBe(1);
    await again.unmount();
    clock = NOW + REWARDS_STALE_MS + 1000;
    const stale = await renderHook(() => useRewards({ api, appState }), { wrapper });
    await waitFor(() => expect(fetches(api)).toBe(2));
    await stale.unmount();
  });

  test('the foreground refetches only when stale; never in the background; no timer', async () => {
    const { api, hook, appState } = await mount();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await act(async () => appState.emit('active'));
    expect(fetches(api)).toBe(1);
    clock = NOW + REWARDS_STALE_MS + 1;
    await act(async () => appState.emit('background'));
    expect(fetches(api)).toBe(1);
    await act(async () => appState.emit('active'));
    await waitFor(() => expect(fetches(api)).toBe(2));
    await hook.unmount();
    expect(appState.count()).toBe(0);
  });

  test("a landed sync refreshes ['rewards'] through the data layer's subscribeInvalidation (ruling 3)", async () => {
    expect(QUERY_ROOTS).toContain('rewards');
    const { api, hook, client } = await mount();
    await waitFor(() => expect(fetches(api)).toBe(1));
    // What bootstrap wires for the runtime's query client.
    const detach = subscribeInvalidation(client);
    clock += 61_000; // past the 60 s floor (round 2, I2)
    await act(async () => {
      emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } });
      await new Promise((r) => setTimeout(r, 5));
    });
    await waitFor(() => expect(fetches(api)).toBe(2));
    detach();
    await hook.unmount();
  });

  test('the hook adds no change listener of its own: without subscribeInvalidation a sync refreshes nothing', async () => {
    const { api, hook } = await mount();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await act(async () => {
      emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } });
      await new Promise((r) => setTimeout(r, 5));
    });
    await settleInbox();
    expect(fetches(api)).toBe(1);
    await hook.unmount();
  });

  test("the notification host's invalidation of REWARDS_QUERY_KEY reaches it", async () => {
    const { api, client, hook } = await mount();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await act(async () => {
      await client.invalidateQueries({ queryKey: REWARDS_QUERY_KEY });
    });
    await waitFor(() => expect(fetches(api)).toBe(2));
    await hook.unmount();
  });

  test('offline: the cache with offline: true, and no request', async () => {
    setOnline(false);
    const db = await createTestDb();
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot({ fetchedAt: NOW - 1000 }));
    const client = testQueryClient();
    const { api } = fakeApi();
    const hook = await renderHook(() => tracked(useRewards({ api, appState: fakeAppState() })), { wrapper: wrapperFor(db, client, () => clock) });
    await waitFor(() => expect(hook.result.current.data?.offline).toBe(true));
    expect(hook.result.current.data?.snapshot.fetchedAt).toBe(NOW - 1000);
    expect(fetches(api)).toBe(0);
    await hook.unmount();
  });

  test('unreachable (a request that never arrived): the cache with offline: true', async () => {
    const db = await createTestDb();
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot());
    const client = testQueryClient();
    const { api, server } = fakeApi();
    server.fail = new RewardsOfflineError();
    const hook = await renderHook(() => tracked(useRewards({ api, appState: fakeAppState() })), { wrapper: wrapperFor(db, client, () => clock) });
    await waitFor(() => expect(hook.result.current.data?.offline).toBe(true));
    await hook.unmount();
  });

  test("offline with only another account's cache: an offline error, never their rewards", async () => {
    setOnline(false);
    const db = await createTestDb();
    await writeCachedRewards(createSettingsRepo(db), OTHER_UID, snapshot());
    const client = testQueryClient();
    const { api } = fakeApi();
    const hook = await renderHook(() => tracked(useRewards({ api, appState: fakeAppState() })), { wrapper: wrapperFor(db, client, () => clock) });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.error).toBeInstanceOf(RewardsOfflineError);
    await hook.unmount();
  });

  test('a server refusal is an error (the screen shows it with a retry), not the cache', async () => {
    const db = await createTestDb();
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot());
    const client = testQueryClient();
    const { api, server } = fakeApi();
    server.fail = { code: '42501', message: 'permission denied' };
    const hook = await renderHook(() => tracked(useRewards({ api, appState: fakeAppState() })), { wrapper: wrapperFor(db, client, () => clock) });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    await hook.unmount();
  });

  test('signed out: disabled, nothing fetched', async () => {
    mockSession.session = null;
    const { api, hook } = await mount();
    await settleInbox();
    expect(fetches(api)).toBe(0);
    expect(hook.result.current.data).toBeUndefined();
  });
});

describe('useRewardDay', () => {
  test("a day among the snapshot's 35: its row, no extra select", async () => {
    const db = await createTestDb();
    const client = testQueryClient();
    const { api } = fakeApi();
    const hook = await renderHook(() => tracked(useRewardDay('2026-09-22', { api, appState: fakeAppState() })), {
      wrapper: wrapperFor(db, client, () => clock),
    });
    await waitFor(() => expect(hook.result.current.data).toMatchObject({ day: '2026-09-22' }));
    expect(api.fetchRewardDay).not.toHaveBeenCalled();
    await hook.unmount();
  });

  test('a day inside the window with no row: null (not settled), no extra select', async () => {
    const db = await createTestDb();
    const client = testQueryClient();
    const { api } = fakeApi();
    const hook = await renderHook(() => tracked(useRewardDay('2026-09-23', { api, appState: fakeAppState() })), {
      wrapper: wrapperFor(db, client, () => clock),
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toBeNull();
    expect(api.fetchRewardDay).not.toHaveBeenCalled();
    await hook.unmount();
  });

  test('a day older than a full 35-day snapshot: one owner select, keyed [rewards, day, uid, day]', async () => {
    const days = Array.from({ length: 35 }, (_, i) =>
      rewardDayRow(new Date(Date.UTC(2026, 8, 22 - i)).toISOString().slice(0, 10))
    );
    const db = await createTestDb();
    const client = testQueryClient();
    const { api, server } = fakeApi(snapshot({ days }));
    server.days.set('2026-07-01', rewardDayRow('2026-07-01', { tier: 'good', points: 20 }));
    const hook = await renderHook(() => tracked(useRewardDay('2026-07-01', { api, appState: fakeAppState() })), {
      wrapper: wrapperFor(db, client, () => clock),
    });
    await waitFor(() => expect(hook.result.current.data).toMatchObject({ day: '2026-07-01', tier: 'good' }));
    expect(api.fetchRewardDay).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(rewardDayKey(UID, '2026-07-01'))).toMatchObject({ day: '2026-07-01' });
    await hook.unmount();
  });

  test('offline, an older day: an error, never null (a missing row must not read as "not settled")', async () => {
    const days = Array.from({ length: 35 }, (_, i) =>
      rewardDayRow(new Date(Date.UTC(2026, 8, 22 - i)).toISOString().slice(0, 10))
    );
    setOnline(false);
    const db = await createTestDb();
    await writeCachedRewards(createSettingsRepo(db), UID, snapshot({ days }));
    const client = testQueryClient();
    const { api } = fakeApi();
    const hook = await renderHook(() => tracked(useRewardDay('2026-07-01', { api, appState: fakeAppState() })), {
      wrapper: wrapperFor(db, client, () => clock),
    });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(hook.result.current.data).toBeUndefined();
    expect(api.fetchRewardDay).not.toHaveBeenCalled();
    await hook.unmount();
  });
});

test('useRewardDay offline: a day the cached snapshot holds is answered; one it lacks is unknown (an error), never null', async () => {
  setOnline(false);
  const db = await createTestDb();
  await writeCachedRewards(createSettingsRepo(db), UID, snapshot());
  const client = testQueryClient();
  const { api } = fakeApi();
  const wrapper = wrapperFor(db, client, () => clock);
  const held = await renderHook(() => tracked(useRewardDay('2026-09-22', { api, appState: fakeAppState() })), { wrapper });
  await waitFor(() => expect(held.result.current.data).toMatchObject({ day: '2026-09-22' }));
  await held.unmount();
  // Online, 09-23 would read "not settled" from the snapshot; from a saved copy it is unknown.
  const lacked = await renderHook(() => tracked(useRewardDay('2026-09-23', { api, appState: fakeAppState() })), { wrapper });
  await waitFor(() => expect(lacked.result.current.isError).toBe(true));
  expect(lacked.result.current.error).toBeInstanceOf(RewardsOfflineError);
  expect(api.fetchRewardDay).not.toHaveBeenCalled();
  await lacked.unmount();
});

describe('useDayAward (T7 round 1, I1)', () => {
  async function award(
    day: string,
    snap: RewardsSnapshot,
    opts: { offline?: boolean } = {}
  ) {
    const db = await createTestDb();
    if (opts.offline) {
      setOnline(false);
      await writeCachedRewards(createSettingsRepo(db), UID, snap);
    }
    const client = testQueryClient();
    const { api } = fakeApi(snap);
    const hook = await renderHook(
      () => {
        const r = useDayAward(day, { api, appState: fakeAppState() });
        void [r.status, r.data, r.error];
        return r;
      },
      { wrapper: wrapperFor(db, client, () => clock) }
    );
    await waitFor(() => expect(hook.result.current.status).not.toBe('pending'));
    const result = hook.result.current;
    await hook.unmount();
    return result;
  }

  const progress = { rewards_start: '2026-09-10', settled_through: '2026-09-21' };

  test('settled: the row', async () => {
    const result = await award('2026-09-22', snapshot({ progress: progressRow(progress) }));
    expect(result.data).toMatchObject({ status: 'settled', settled: true });
  });

  test('pending: after the frontier, no row', async () => {
    const result = await award('2026-09-23', snapshot({ progress: progressRow(progress) }));
    expect(result.data).toEqual({ status: 'pending', settled: false });
  });

  test('not_counted: behind the frontier with no row (a late day)', async () => {
    const days = [rewardDayRow('2026-09-21'), rewardDayRow('2026-09-19')];
    const result = await award('2026-09-20', snapshot({ progress: progressRow(progress), days }));
    expect(result.data).toMatchObject({ status: 'not_counted', reason: 'after_confirmed' });
  });

  test('not_counted: before rewards started', async () => {
    const result = await award('2026-09-05', snapshot({ progress: progressRow(progress), days: [rewardDayRow('2026-09-21')] }));
    expect(result.data).toMatchObject({ status: 'not_counted', reason: 'before_rewards', rewardsStart: '2026-09-10' });
  });

  test('a new user with no progress row: pending', async () => {
    const result = await award('2026-09-05', snapshot({ progress: null, days: [] }));
    expect(result.data).toEqual({ status: 'pending', settled: false });
  });

  test("a frozen late day ('late') in the snapshot: not_counted, after_confirmed", async () => {
    const late = rewardDayRow('2026-09-20', {
      outcome: 'neutral',
      outcome_reason: 'late',
      tier: 'none',
      phone_free: false,
      points: 0,
    });
    const result = await award('2026-09-20', snapshot({ progress: progressRow(progress), days: [rewardDayRow('2026-09-21'), late] }));
    expect(result.data).toMatchObject({ status: 'not_counted', reason: 'after_confirmed' });
  });

  test("a genuine no-drive day ('no_drive') in the snapshot: settled with no points (negative control)", async () => {
    const noDrive = rewardDayRow('2026-09-20', {
      outcome: 'neutral',
      outcome_reason: 'no_drive',
      tier: 'none',
      phone_free: false,
      points: 0,
    });
    const result = await award('2026-09-20', snapshot({ progress: progressRow(progress), days: [rewardDayRow('2026-09-21'), noDrive] }));
    expect(result.data).toMatchObject({ status: 'settled', settled: true, points: 0 });
  });

  test('offline, a day the saved copy lacks: unknown (an error), neither pending nor not_counted', async () => {
    const result = await award('2026-09-20', snapshot({ progress: progressRow(progress) }), { offline: true });
    expect(result.status).toBe('error');
    expect(result.data).toBeUndefined();
  });
});

describe('mutations invalidate the rewards on success', () => {
  async function mutate<T>(use: (deps: { api: RewardsApi }) => { mutateAsync: (v: T) => Promise<unknown> }, value: T) {
    const w = await mount();
    await waitFor(() => expect(fetches(w.api)).toBe(1));
    const m = await renderHook(() => use({ api: w.api }), { wrapper: w.wrapper });
    await act(async () => {
      await m.result.current.mutateAsync(value);
    });
    await waitFor(() => expect(fetches(w.api)).toBe(2));
    await m.unmount();
    await w.hook.unmount();
    return w;
  }

  test('useSetWeeklyFocus', async () => {
    const w = await mutate(useSetWeeklyFocus, 'braking' as const);
    expect(w.api.setWeeklyFocus).toHaveBeenCalledWith('braking');
  });

  test('useJoinChallenge', async () => {
    const w = await mutate(useJoinChallenge, 'phone_down');
    expect(w.api.joinChallenge).toHaveBeenCalledWith('phone_down');
  });

  test('useLeaveChallenge', async () => {
    const w = await mutate(useLeaveChallenge, '00000000-0000-4000-8000-000000000123');
    expect(w.api.leaveChallenge).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000123');
  });

  test('offline: refused as offline without a call', async () => {
    setOnline(false);
    const db = await createTestDb();
    const client = testQueryClient();
    const { api } = fakeApi();
    const m = await renderHook(() => useJoinChallenge({ api }), { wrapper: wrapperFor(db, client, () => clock) });
    let error: unknown;
    await act(async () => {
      error = await m.result.current.mutateAsync('phone_down').catch((e: unknown) => e);
    });
    expect(error).toBeInstanceOf(RewardsRpcError);
    expect((error as RewardsRpcError).code).toBe('offline');
    expect(api.joinChallenge).not.toHaveBeenCalled();
    await m.unmount();
  });
});
