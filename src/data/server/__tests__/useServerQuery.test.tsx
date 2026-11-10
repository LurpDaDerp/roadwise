import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { RpcError } from '../rpc';
import { useServerQuery } from '../useServerQuery';

const mockCallRpc = jest.fn<Promise<unknown>, []>(async () => ({ ok: true }));
jest.mock('../rpc', () => {
  class MockRpcError extends Error {
    code: string | null;
    constructor(message: string, code: string | null) {
      super(message);
      this.code = code;
    }
  }
  return { RpcError: MockRpcError, callRpc: (...a: unknown[]) => mockCallRpc(...(a as [])) };
});
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]) };
});

let appStateListener: ((s: AppStateStatus) => void) | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  mockCallRpc.mockClear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
    appStateListener = l as (s: AppStateStatus) => void;
    return { remove: () => (appStateListener = null) };
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

it('sends one request when a screen with stale cached data mounts and gains focus', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['server', 'u1', 'summary'], { ok: false }, { updatedAt: Date.now() - 5 * 60_000 });
  const { unmount } = await renderHook(() => useServerQuery(['summary'], 'get_my_summary'), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(1);
  await unmount();
});

it('polls while active and stops once the app goes to the background', async () => {
  await renderHook(() => useServerQuery(['league'], 'get_my_league', undefined, { pollMs: 60_000 }), {
    wrapper,
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  const afterMount = mockCallRpc.mock.calls.length;
  expect(afterMount).toBeGreaterThanOrEqual(1);

  await act(async () => {
    await jest.advanceTimersByTimeAsync(60_000);
  });
  expect(mockCallRpc.mock.calls.length).toBe(afterMount + 1);

  await act(async () => {
    appStateListener?.('background');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(mockCallRpc.mock.calls.length).toBe(afterMount + 1);
});

it('sends nothing while the app was launched in the background, then fetches on the first active', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
  await renderHook(() => useServerQuery(['summary'], 'get_my_summary'), { wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5_000);
  });
  expect(mockCallRpc).not.toHaveBeenCalled();

  await act(async () => {
    appStateListener?.('active');
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(1);
});

it('fetches when the app came to the front between the first render and the subscription', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
    // The 'active' change fired before this listener existed.
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    appStateListener = l as (s: AppStateStatus) => void;
    return { remove: () => (appStateListener = null) };
  });
  await renderHook(() => useServerQuery(['summary'], 'get_my_summary'), { wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(1);
});

it('a short inactive after the first active does not hold back a query that mounts then', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
  const { rerender } = await renderHook(({ on }: { on: boolean }) => useServerQuery(['friends'], 'list_friends', undefined, { enabled: on }), {
    wrapper,
    initialProps: { on: false },
  });
  await act(async () => {
    appStateListener?.('active');
    appStateListener?.('inactive');
    await jest.advanceTimersByTimeAsync(0);
  });
  await rerender({ on: true });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(1);
});

it('does not retry a refusal the server would repeat (profile not found)', async () => {
  mockCallRpc.mockRejectedValue(new RpcError('profile not found', 'P0002'));
  const { result } = await renderHook(() => useServerQuery(['profile', 'x'], 'get_profile').status, { wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(1);
  expect(result.current).toBe('error');
  mockCallRpc.mockReset();
  mockCallRpc.mockImplementation(async () => ({ ok: true }));
});

it('retries a network failure once', async () => {
  mockCallRpc.mockRejectedValue(new RpcError('Failed to fetch', null));
  const { result } = await renderHook(() => useServerQuery(['profile', 'y'], 'get_profile').status, { wrapper });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(mockCallRpc).toHaveBeenCalledTimes(2);
  expect(result.current).toBe('error');
  mockCallRpc.mockReset();
  mockCallRpc.mockImplementation(async () => ({ ok: true }));
});
