import { act, renderHook, waitFor } from '@testing-library/react-native';

import { clearInboxClients, fakeAppState, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';

import { ReferralError } from '../api';
import {
  readCachedReferrals,
  REFERRAL_CACHE_KEY,
  REFERRAL_STALE_MS,
  referralCodeKey,
  referralsKey,
  useMyReferralCode,
  useRedeemReferralCode,
  useReferrals,
  writeCachedReferrals,
} from '../useReferrals';
import { CODE, fakeReferralApi, noRefresh, referralWorld, referrals, UID } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession = { current: { session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } } as unknown };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession.current }));

afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockSession.current = { session: { user: { id: UID } } };
  jest.clearAllMocks();
});

/** Reads status, data and error during render, so React Query re-renders on each (T7's harness note). */
function tracked<T extends { status: string; data: unknown; error: unknown }>(r: T): T {
  void r.status;
  void r.data;
  void r.error;
  return r;
}

describe('the cache', () => {
  test('one account per phone: another uid, or an unreadable shape, reads null', async () => {
    const w = await referralWorld();
    await writeCachedReferrals(w.settings, UID, referrals({ joined: 2 }));
    expect(await readCachedReferrals(w.settings, UID)).toEqual(referrals({ joined: 2 }));
    expect(await readCachedReferrals(w.settings, 'someone-else')).toBeNull();
    await w.settings.set(REFERRAL_CACHE_KEY, { uid: UID, snapshot: { ...referrals(), name: 'Sam' } });
    expect(await readCachedReferrals(w.settings, UID)).toBeNull();
    expect(REFERRAL_CACHE_KEY).toBe('referral.snapshot');
  });
});

describe('useReferrals', () => {
  test('the key sits under the rewards root, per uid, with a 5-minute stale', () => {
    expect(referralsKey(UID)).toEqual(['rewards', 'referrals', UID]);
    expect(referralCodeKey(UID)).toEqual(['rewards', 'referrals', UID, 'code']);
    expect(REFERRAL_STALE_MS).toBe(300_000);
  });

  test('flag on: fetches, answers, and caches for this account', async () => {
    const w = await referralWorld({ referral: true });
    const { api } = fakeReferralApi(referrals({ joined: 3, qualified: 1 }));
    const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
    await waitFor(() => expect(result.current.data?.snapshot.joined).toBe(3));
    expect(result.current.data?.offline).toBe(false);
    expect(await readCachedReferrals(w.settings, UID)).toEqual(referrals({ joined: 3, qualified: 1 }));
    const state = w.client.getQueryCache().find({ queryKey: referralsKey(UID) });
    expect(state).toBeDefined();
  });

  test('flag off (the default): no request at all', async () => {
    for (const referral of [false, undefined]) {
      const w = await referralWorld({ referral });
      const { api } = fakeReferralApi();
      const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
      await settleInbox();
      expect(api.fetchMyReferrals).not.toHaveBeenCalled();
      expect(result.current.data).toBeUndefined();
      await clearInboxClients();
    }
  });

  test('signed out: no request', async () => {
    mockSession.current = { session: null };
    const w = await referralWorld({ referral: true });
    const { api } = fakeReferralApi();
    await renderHook(() => useReferrals({ api, refreshConfig: noRefresh }), { wrapper: w.wrapper });
    await settleInbox();
    expect(api.fetchMyReferrals).not.toHaveBeenCalled();
  });

  test('offline: this account\'s cached counts, marked offline, with no request', async () => {
    const w = await referralWorld({ referral: true, cached: referrals({ joined: 5 }) });
    setOnline(false);
    const { api } = fakeReferralApi();
    const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
    await waitFor(() => expect(result.current.data?.offline).toBe(true));
    expect(result.current.data?.snapshot.joined).toBe(5);
    expect(api.fetchMyReferrals).not.toHaveBeenCalled();
  });

  test('unreachable: the cache too', async () => {
    const w = await referralWorld({ referral: true, cached: referrals({ joined: 5 }) });
    const { api, server } = fakeReferralApi();
    server.fail.fetch = 'offline';
    const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
    await waitFor(() => expect(result.current.data?.offline).toBe(true));
  });

  test("offline with only another account's cache: an error, never their counts", async () => {
    const w = await referralWorld({ referral: true });
    await writeCachedReferrals(w.settings, 'someone-else', referrals({ joined: 9 }));
    setOnline(false);
    const { api } = fakeReferralApi();
    const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ReferralError).code).toBe('offline');
  });

  test('a refusal is an error (not the cache)', async () => {
    const w = await referralWorld({ referral: true, cached: referrals({ joined: 5 }) });
    const { api, server } = fakeReferralApi();
    server.fail.fetch = 'not_available';
    const { result } = await renderHook(() => tracked(useReferrals({ api, refreshConfig: noRefresh })), { wrapper: w.wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ReferralError).code).toBe('not_available');
  });

  test('a foreground refetches only when stale, and listeners are removed on unmount', async () => {
    const w = await referralWorld({ referral: true });
    const { api } = fakeReferralApi();
    const appState = fakeAppState();
    const { result, unmount } = await renderHook(
      () => tracked(useReferrals({ api, appState, refreshConfig: noRefresh })),
      { wrapper: w.wrapper }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.fetchMyReferrals).toHaveBeenCalledTimes(1);
    await act(async () => appState.emit('active'));
    await settleInbox();
    expect(api.fetchMyReferrals).toHaveBeenCalledTimes(1);

    const realNow = Date.now;
    const later = realNow() + REFERRAL_STALE_MS + 1;
    Date.now = () => later;
    try {
      await act(async () => appState.emit('active'));
      await settleInbox();
      expect(api.fetchMyReferrals).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
    const before = appState.count();
    await unmount();
    expect(appState.count()).toBeLessThan(before);
  });
});

describe('useMyReferralCode', () => {
  test('fetches the code only when asked for', async () => {
    const w = await referralWorld({ referral: true });
    const { api } = fakeReferralApi();
    await renderHook(() => useMyReferralCode({ api, refreshConfig: noRefresh, enabled: false }), { wrapper: w.wrapper });
    await settleInbox();
    expect(api.getMyReferralCode).not.toHaveBeenCalled();
  });

  test('flag off: never asks', async () => {
    const w = await referralWorld({ referral: false });
    const { api } = fakeReferralApi();
    await renderHook(() => useMyReferralCode({ api, refreshConfig: noRefresh }), { wrapper: w.wrapper });
    await settleInbox();
    expect(api.getMyReferralCode).not.toHaveBeenCalled();
  });

  test('asks once, and fills a cached snapshot that had no code yet', async () => {
    const w = await referralWorld({ referral: true, cached: referrals({ code: null }) });
    const { api } = fakeReferralApi(referrals({ code: null }));
    const { result } = await renderHook(() => tracked(useMyReferralCode({ api, refreshConfig: noRefresh })), {
      wrapper: w.wrapper,
    });
    await waitFor(() => expect(result.current.data).toBe(CODE));
    expect(api.getMyReferralCode).toHaveBeenCalledTimes(1);
    expect((await readCachedReferrals(w.settings, UID))?.code).toBe(CODE);
  });

  test("offline: the cached code; with none cached, an offline error", async () => {
    const w = await referralWorld({ referral: true, cached: referrals() });
    setOnline(false);
    const { api } = fakeReferralApi();
    const { result } = await renderHook(() => tracked(useMyReferralCode({ api, refreshConfig: noRefresh })), {
      wrapper: w.wrapper,
    });
    await waitFor(() => expect(result.current.data).toBe(CODE));
    expect(api.getMyReferralCode).not.toHaveBeenCalled();
    await clearInboxClients();

    const empty = await referralWorld({ referral: true, cached: referrals({ code: null }) });
    const second = await renderHook(() => tracked(useMyReferralCode({ api, refreshConfig: noRefresh })), {
      wrapper: empty.wrapper,
    });
    await waitFor(() => expect(second.result.current.isError).toBe(true));
    expect((second.result.current.error as ReferralError).code).toBe('offline');
  });
});

describe('useRedeemReferralCode', () => {
  test('offline: refused without a request', async () => {
    const w = await referralWorld({ referral: true });
    setOnline(false);
    const { api } = fakeReferralApi();
    const { result } = await renderHook(() => useRedeemReferralCode({ api }), { wrapper: w.wrapper });
    let caught: unknown;
    await act(async () => {
      await result.current.mutateAsync(CODE).catch((e: unknown) => (caught = e));
    });
    expect((caught as ReferralError).code).toBe('offline');
    expect(api.redeemReferralCode).not.toHaveBeenCalled();
  });

  test('success refreshes the status', async () => {
    const w = await referralWorld({ referral: true });
    const { api } = fakeReferralApi(referrals({ canRedeem: true }));
    const { result } = await renderHook(
      () => ({
        list: tracked(useReferrals({ api, refreshConfig: noRefresh })),
        redeem: useRedeemReferralCode({ api }),
      }),
      { wrapper: w.wrapper }
    );
    await waitFor(() => expect(result.current.list.data?.snapshot.canRedeem).toBe(true));
    await act(async () => {
      await result.current.redeem.mutateAsync(CODE);
    });
    await waitFor(() => expect(result.current.list.data?.snapshot.myCode).toBe('pending'));
    expect(result.current.list.data?.snapshot.canRedeem).toBe(false);
  });
});
