import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useServerQuery } from '../useServerQuery';

const mockCallRpc = jest.fn(async () => ({ ok: true }));
jest.mock('../rpc', () => ({ callRpc: (...a: unknown[]) => mockCallRpc(...(a as [])) }));
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

it('polls while active and stops once the app goes to the background', async () => {
  renderHook(() => useServerQuery(['league'], 'get_my_league', undefined, { pollMs: 60_000 }), {
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
